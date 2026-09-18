import { KnowledgeBaseRetriever } from '../kb/retriever.js';
import { ToolRegistry } from '../tools/registry.js';
import { LlmClient, MockLlmClient } from '../llm/client.js';
import { GuardrailEngine } from './guardrails.js';
import { IntentClassifier } from './intent-classifier.js';
import { EmotionDetector } from './emotion-detector.js';
import { ConversationFlowManager } from './conversation-flow.js';
import { getNoDocFallbackResponse } from '../kb/fallback-templates.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { config } from '../config.js';
import { ConversationStage, PlayerEmotion } from '../types.js';
import { AttachmentService } from '../../../gateway/src/attachment-service.js';

export interface OrchestratePlayer {
  uid: string;
  server?: string;
  level?: number;
  vip_tier?: number;
}

export interface OrchestrateHistoryItem {
  sender_type: 'player' | 'bot' | 'agent' | 'system';
  text: string;
}

export interface OrchestrateRequest {
  conversation_id: string;
  locale: string;
  market: string;
  stage?: ConversationStage;
  category?: string;
  collected_slots?: Record<string, string>;
  player: OrchestratePlayer;
  page_context?: Record<string, any>;
  bot_persona?: 'mira' | 'reza' | string;
  history: OrchestrateHistoryItem[];
}

export interface OrchestrateReplyResponse {
  action: 'reply';
  text: string;
  meta: {
    intent: string;
    confidence: number;
    stage?: ConversationStage;
    collected_slots?: Record<string, string>;
    current_slot?: string;
    emotion?: PlayerEmotion;
    sources: string[];
    tools_used: string[];
    locale_out: string;
    guardrail_flags: string[];
  };
}

export interface OrchestrateHandoffResponse {
  action: 'handoff';
  reason: string;
  bot_summary: string;
  meta: {
    intent: string;
    confidence: number;
    stage?: ConversationStage;
    collected_slots?: Record<string, string>;
    current_slot?: string;
    emotion?: PlayerEmotion;
    sources: string[];
    tools_used: string[];
    locale_out: string;
    guardrail_flags: string[];
  };
}

export type OrchestrateResponse = OrchestrateReplyResponse | OrchestrateHandoffResponse;

function isFollowUpQuestion(text: string): boolean {
  const cleaned = text.toLowerCase().trim();
  const followUpIndicators = [
    'gimana caranya', 'bagaimana caranya', 'caranya gimana', 'caranya bagaimana',
    'langkahnya', 'langkah-langkahnya', 'terus gimana', 'lalu gimana', 'lalu bagaimana',
    'bisa tolong', 'tolong jelaskan', 'jelaskan', 'cara nya', 'apa saja metodenya',
    'bisa lewat apa', 'seperti apa', 'bagaimana ya', 'gimana ya',
    'how to do it', 'how do i do that', 'how can i', 'how to', 'what steps',
    'ทำยังไง', 'อย่างไร', 'làm thế nào', 'như thế nào', 'paano'
  ];
  if (followUpIndicators.some((kw) => cleaned.includes(kw))) {
    return true;
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 4 && (cleaned.includes('?') || cleaned.includes('gimana') || cleaned.includes('bagaimana'))) {
    return true;
  }
  return false;
}

export function buildContextualQuery(latestMessage: string, history: OrchestrateHistoryItem[]): string {
  // Ambil hingga 20 pesan terakhir
  const recentHistory = (history || []).slice(-20);
  if (recentHistory.length <= 1) {
    return latestMessage;
  }

  // Cek apakah pesan terkini adalah pertanyaan lanjutan (follow-up)
  if (isFollowUpQuestion(latestMessage)) {
    // Ambil topik dari pesan-pesan pemain sebelumnya
    const priorPlayerMessages = recentHistory
      .slice(0, -1)
      .filter((m) => m.sender_type === 'player')
      .map((m) => m.text.trim())
      .filter(Boolean);

    if (priorPlayerMessages.length > 0) {
      // Gabungkan konteks pesan pemain sebelumnya dengan pertanyaan lanjutan
      const contextPrefix = priorPlayerMessages.slice(-2).join(' ');
      return `${contextPrefix} ${latestMessage}`;
    }
  }

  return latestMessage;
}

export class AIOrchestrator {
  public kbRetriever: KnowledgeBaseRetriever;
  public toolRegistry: ToolRegistry;
  public llmClient: LlmClient;
  public guardrails: GuardrailEngine;
  public intentClassifier: IntentClassifier;
  public emotionDetector: EmotionDetector;
  public flowManager: ConversationFlowManager;

  constructor(options: {
    kbRetriever: KnowledgeBaseRetriever;
    toolRegistry?: ToolRegistry;
    llmClient?: LlmClient;
    guardrails?: GuardrailEngine;
    intentClassifier?: IntentClassifier;
    emotionDetector?: EmotionDetector;
    flowManager?: ConversationFlowManager;
  }) {
    this.kbRetriever = options.kbRetriever;
    this.toolRegistry = options.toolRegistry || new ToolRegistry();
    this.llmClient = options.llmClient || new MockLlmClient();
    this.guardrails = options.guardrails || new GuardrailEngine();
    this.intentClassifier = options.intentClassifier || new IntentClassifier();
    this.emotionDetector = options.emotionDetector || new EmotionDetector();
    this.flowManager = options.flowManager || new ConversationFlowManager();
  }

  /**
   * Eksekusi Pipeline Orchestrator dengan Kemampuan Percakapan Berkelanjutan
   */
  async process(req: OrchestrateRequest): Promise<OrchestrateResponse> {
    const locale = req.locale || 'en';
    const recentHistory = (req.history || []).slice(-20);
    const playerMessages = recentHistory.filter((h) => h.sender_type === 'player');
    const latestPlayerMessage =
      playerMessages.length > 0 ? playerMessages[playerMessages.length - 1].text : '';

    // Resolusi konteks untuk pertanyaan lanjutan (follow-up)
    const contextualQuery = buildContextualQuery(latestPlayerMessage, recentHistory);

    // =========================================================================
    // Deteksi Emosi Pemain (Empati & Pengakuan Perasaan - Syarat 4)
    // =========================================================================
    const emotionResult = this.emotionDetector.detect(latestPlayerMessage, locale);

    // =========================================================================
    // LANGKAH 1: Cek pemicu keras (Hard Trigger)
    // =========================================================================
    // Keras -> langsung handoff, model TIDAK DIPANGGIL sama sekali!
    const hardTrigger = this.guardrails.checkHardTrigger(latestPlayerMessage, locale);
    if (hardTrigger.matched && hardTrigger.ruleKey) {
      return {
        action: 'handoff',
        reason: hardTrigger.ruleKey,
        bot_summary:
          hardTrigger.botSummary ||
          `Hard trigger detected: ${hardTrigger.ruleKey}. Handing off directly without model call.`,
        meta: {
          intent: hardTrigger.ruleKey,
          confidence: 1.0,
          stage: 'escalation',
          emotion: emotionResult.emotion,
          sources: [],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: [`hard_trigger:${hardTrigger.ruleKey}`],
        },
      };
    }

    // =========================================================================
    // LANGKAH 2: Klasifikasi Intent & Pemicu Lunak
    // =========================================================================
    // 2.1 Cek pemicu lunak (seperti minta_manusia)
    const softTrigger = this.guardrails.checkSoftTrigger(latestPlayerMessage, locale);
    if (softTrigger.matched && softTrigger.ruleKey) {
      return {
        action: 'handoff',
        reason: softTrigger.ruleKey,
        bot_summary:
          softTrigger.botSummary ||
          `Soft trigger triggered: ${softTrigger.ruleKey}. Handing off to human agent.`,
        meta: {
          intent: softTrigger.ruleKey,
          confidence: 1.0,
          stage: 'escalation',
          emotion: emotionResult.emotion,
          sources: [],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: [`soft_trigger:${softTrigger.ruleKey}`],
        },
      };
    }

    // 2.2 Pengumpulan Data Bertahap (Sequential Slot Filling - Syarat 3)
    // Cek apakah percakapan berada di tahap pengumpulan data atau keluhan topup belum masuk
    const isUncreditedComplaint =
      this.flowManager.isTopupUncreditedComplaint(latestPlayerMessage) ||
      this.flowManager.isTopupUncreditedComplaint(contextualQuery) ||
      req.stage === 'data_collection';

    if (isUncreditedComplaint) {
      const existingSlots = req.collected_slots || req.page_context?.collected_slots || {};
      const targetSlotKey = req.page_context?.current_slot;

      // Syarat 3: Jika pemain menulis "sudah saya kirim" / "ini fotonya" tapi tidak ada lampiran,
      // bot TIDAK BOLEH mengulang pertanyaan verbatim!
      const hasAttachment = Boolean(
        (req as any).attachment_url ||
        (req as any).meta?.attachment ||
        /https?:\/\/.*?\.(png|jpg|jpeg|webp)|\[Attachment/i.test(latestPlayerMessage)
      );
      if (!hasAttachment && AttachmentService.isClaimingSentAttachment(latestPlayerMessage)) {
        const explanation = AttachmentService.getMissingAttachmentExplanation(locale, req.bot_persona);
        return {
          action: 'reply',
          text: explanation,
          meta: {
            intent: 'missing_attachment_help',
            confidence: 0.95,
            stage: 'data_collection',
            collected_slots: existingSlots,
            current_slot: targetSlotKey || 'order_id',
            needs_evidence: true,
            evidence_type: 'attachment',
            sources: ['attachment_system'],
            tools_used: [],
            locale_out: locale,
            guardrail_flags: [],
          },
        };
      }

      const updatedSlots = this.flowManager.extractSlots(latestPlayerMessage, existingSlots, targetSlotKey);
      const slotProgress = this.flowManager.evaluateSlotProgress(updatedSlots, locale);

      if (!slotProgress.isComplete) {
        // Tanyakan slot berikutnya SATU PER SATU
        let questionText = slotProgress.questionText || '';
        // Syarat 4: Jika emosi kesal, akui dulu keluhannya sebelum masuk ke slot/solusi
        if (emotionResult.isFrustrated) {
          questionText = this.emotionDetector.wrapWithEmpathy(questionText, locale, true);
        }

        const isEvidenceSlot = slotProgress.nextSlotToAsk === 'order_id';

        return {
          action: 'reply',
          text: questionText,
          meta: {
            intent: 'topup_uncredited',
            confidence: 0.92,
            stage: 'data_collection',
            collected_slots: updatedSlots,
            current_slot: slotProgress.nextSlotToAsk,
            needs_evidence: isEvidenceSlot,
            evidence_type: isEvidenceSlot ? 'attachment' : undefined,
            emotion: emotionResult.emotion,
            sources: ['slot_collection'],
            tools_used: [],
            locale_out: locale,
            guardrail_flags: [],
          },
        };
      } else {
        // Semua data terkumpul -> tahap resolusi
        let summaryText = this.flowManager.buildCompletionSummary(updatedSlots, locale);
        if (emotionResult.isFrustrated) {
          summaryText = this.emotionDetector.wrapWithEmpathy(summaryText, locale, true);
        }
        const toolsUsed: string[] = [];
        const toolsContext: any[] = [];

        if (updatedSlots.order_id) {
          try {
            const toolRes = await this.toolRegistry.executeTool(
              'get_transaction',
              { order_id: updatedSlots.order_id },
              {
                verifiedPlayer: req.player,
                conversationId: req.conversation_id,
                locale,
              }
            );
            toolsUsed.push('get_transaction');
            toolsContext.push(toolRes.result);
          } catch {}
        }

        return {
          action: 'reply',
          text: summaryText,
          meta: {
            intent: 'topup_uncredited',
            confidence: 0.95,
            stage: 'resolution',
            collected_slots: updatedSlots,
            emotion: emotionResult.emotion,
            sources: ['slot_collection'],
            tools_used: toolsUsed,
            locale_out: locale,
            guardrail_flags: [],
          },
        };
      }
    }

    // 2.3 Klasifikasi intent dan confidence score dengan kueri berkonteks & pembatasan taksonomi kategori
    const intentResult = await this.intentClassifier.classify(contextualQuery, req.category);

    // Jika confidence < 0.75 -> langsung handoff
    if (intentResult.confidence < config.confidenceThreshold) {
      return {
        action: 'handoff',
        reason: 'keyakinan_rendah',
        bot_summary: `Low intent confidence score (${intentResult.confidence.toFixed(2)} < ${config.confidenceThreshold}). Escalating to human agent.`,
        meta: {
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          stage: 'escalation',
          emotion: emotionResult.emotion,
          sources: [],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: ['keyakinan_rendah'],
        },
      };
    }

    // 2.3.1 Jika intent adalah minta_manusia -> langsung handoff
    if (intentResult.intent === 'minta_manusia') {
      return {
        action: 'handoff',
        reason: 'minta_manusia',
        bot_summary: `Player requested human agent: "${latestPlayerMessage}"`,
        meta: {
          intent: 'minta_manusia',
          confidence: intentResult.confidence,
          stage: 'escalation',
          emotion: emotionResult.emotion,
          sources: [],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: ['soft_trigger:minta_manusia'],
        },
      };
    }

    // =========================================================================
    // 2.4 Tangani Sapaan (greeting) & Pertanyaan Kabur (discovery - Syarat 1)
    // =========================================================================
    // Sapaan kabur tanpa isi jelas TIDAK PERNAH memicu pengambilan dokumen.
    // Bot langsung bertanya balik seperti CS manusia sungguhan.
    if (
      intentResult.intent === 'greeting' ||
      intentResult.intent === 'vague_inquiry' ||
      intentResult.intent === 'topup_clarification'
    ) {
      let clarificationText = '';
      let targetStage: ConversationStage = 'discovery';

      if (intentResult.intent === 'greeting') {
        targetStage = 'greeting';
        clarificationText =
          locale === 'id-ID'
            ? 'Halo kak! Ada yang bisa dibantu?'
            : locale === 'th-TH'
            ? 'สวัสดีค่ะ มีอะไรให้เราช่วยเหลือไหมคะ'
            : 'Hello! How may I assist you today?';
      } else if (intentResult.intent === 'topup_clarification') {
        targetStage = 'discovery';
        clarificationText =
          locale === 'id-ID'
            ? 'Boleh dibantu kak. Kendalanya apa ya, diamond belum masuk atau pembayarannya yang gagal?'
            : locale === 'th-TH'
            ? 'สอบถามเพิ่มเติมค่ะ ปัญหาเกิดจากเพชรยังไม่เข้า หรือการชำระเงินไม่สำเร็จคะ'
            : 'Could you tell us more? Did your diamonds not arrive yet, or did the payment fail?';
      } else {
        // vague_inquiry
        targetStage = 'discovery';
        clarificationText =
          locale === 'id-ID'
            ? 'Halo kak! Boleh diceritakan kendalanya seperti apa, biar kami bantu cek?'
            : locale === 'th-TH'
            ? 'สวัสดีค่ะ มีอะไรให้ทางเราช่วยดูแลไหมคะ สามารถแจ้งรายละเอียดปัญหาได้เลยค่ะ'
            : 'Hello! Could you please share more details about the issue so we can assist you?';
      }

      // Syarat 4: Jika pemain kesal, akui keluhan terlebih dahulu
      if (emotionResult.isFrustrated) {
        clarificationText = this.emotionDetector.wrapWithEmpathy(clarificationText, locale, true);
      }

      return {
        action: 'reply',
        text: clarificationText,
        meta: {
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          stage: targetStage,
          emotion: emotionResult.emotion,
          sources: ['canned_clarification'],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: [],
        },
      };
    }

    // =========================================================================
    // LANGKAH 3: Ambil Dokumen (RAG)
    // =========================================================================
    // Dokumen terfilter locale, maks 5 potongan (dengan ambang batas kemiripan dan konteks lanjutan)
    const documents = await this.kbRetriever.search(contextualQuery, locale, {
      limit: 5,
      threshold: config.similarityThreshold,
    });

    // =========================================================================
    // LANGKAH 4: Panggil Tool Bila Perlu
    // =========================================================================
    // Aturan pengisian argumen: player_uid disuntikkan dari sesi terverifikasi!
    const toolsUsed: string[] = [];
    const toolsContext: any[] = [];

    // Deteksi kebutuhan tool cek transaksi jika pemain menyertakan ID order
    const orderMatch = latestPlayerMessage.match(/\b(order_[a-zA-Z0-9]+)\b/i);
    if (orderMatch) {
      const orderId = orderMatch[1];
      try {
        const toolRes = await this.toolRegistry.executeTool(
          'get_transaction',
          { order_id: orderId },
          {
            verifiedPlayer: req.player,
            conversationId: req.conversation_id,
            locale,
          }
        );
        toolsUsed.push('get_transaction');
        toolsContext.push(toolRes.result);
      } catch (err) {
        // Logging kegagalan tool
      }
    }

    // Syarat 2: Penanganan Tanpa Dokumen Cocok (Humane No-Doc Fallback)
    // Bot TIDAK BOLEH diam atau memaksakan dokumen tidak relevan.
    // Jika tidak ada dokumen cocok, tidak ada tool yang dipanggil, dan tidak sedang dalam mock override test:
    if (
      documents.length === 0 &&
      toolsUsed.length === 0 &&
      !(this.llmClient as any)?.overrideResponse
    ) {
      let fallbackText = getNoDocFallbackResponse(locale, emotionResult.isFrustrated);
      if (emotionResult.isFrustrated) {
        fallbackText = this.emotionDetector.wrapWithEmpathy(fallbackText, locale, true);
      }
      return {
        action: 'reply',
        text: fallbackText,
        meta: {
          intent: intentResult.intent || 'faq_inquiry',
          confidence: 0.85,
          stage: req.stage || 'discovery',
          emotion: emotionResult.emotion,
          sources: ['canned_no_doc_fallback'],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: [],
        },
      };
    }

    // =========================================================================
    // LANGKAH 5: Susun Jawaban (Model Bahasa)
    // =========================================================================
    const systemPrompt = buildSystemPrompt(locale, req.bot_persona);
    const llmResponse = await this.llmClient.generate({
      systemPrompt,
      locale,
      userMessage: latestPlayerMessage,
      history: recentHistory,
      documents,
      toolsContext,
    });

    // =========================================================================
    // LANGKAH 6: Filter Output
    // =========================================================================
    // 4 aturan terkunci:
    // 1. Larang janji refund/unban (no_promise)
    // 2. Larang sebut data akun sebelum terverifikasi
    // 3. Wajib ada sumber internal (meta.sources tidak boleh kosong)
    // 4. Ambang keyakinan minimum 0.75
    const filterResult = this.guardrails.filterOutput(
      llmResponse.text,
      llmResponse.sources,
      llmResponse.confidence,
      locale
    );

    if (!filterResult.passed) {
      return {
        action: 'handoff',
        reason: filterResult.reason || 'output_filter_failed',
        bot_summary:
          filterResult.botSummary ||
          'Generated response discarded due to output filter policy violation.',
        meta: {
          intent: intentResult.intent || llmResponse.intent,
          confidence: intentResult.confidence ?? llmResponse.confidence,
          stage: 'escalation',
          emotion: emotionResult.emotion,
          sources: [],
          tools_used: toolsUsed,
          locale_out: locale,
          guardrail_flags: [`filter_failed:${filterResult.reason}`],
        },
      };
    }

    // =========================================================================
    // LANGKAH 7: Kembalikan Reply
    // =========================================================================
    let finalText = llmResponse.text;
    if (emotionResult.isFrustrated) {
      finalText = this.emotionDetector.wrapWithEmpathy(finalText, locale, true);
    }

    return {
      action: 'reply',
      text: finalText,
      meta: {
        intent: intentResult.intent || llmResponse.intent,
        confidence: intentResult.confidence ?? llmResponse.confidence,
        stage: 'resolution',
        emotion: emotionResult.emotion,
        sources: llmResponse.sources,
        tools_used: toolsUsed,
        locale_out: locale,
        guardrail_flags: [],
      },
    };
  }
}
