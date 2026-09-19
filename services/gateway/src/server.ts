import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from './db.js';
import { RedisPubSub } from './redis.js';
import { WebSocketHub } from './websocket-hub.js';
import { verifyGameSessionToken } from './auth.js';
import { InvalidStatusTransitionError, InvalidResolutionReasonError } from './state-machine.js';
import { ConversationStatus, ResolutionReason } from './types.js';
import { StudioService, LockedRuleImmutableError } from './studio-service.js';
import { WaitingCompanion } from '../../orchestrator/src/pipeline/waiting-companion.js';
import {
  calculateTypingDelay,
  isHardTriggerMessage,
  getGracefulFallbackMessage,
  TypingDelayOptions,
} from './typing-indicator.js';
import { CategoryFieldService, CollectedFieldStatus } from './category-field-service.js';
import fastifyCookie from '@fastify/cookie';
import { AttachmentService, AttachmentUploadResult } from './attachment-service.js';
import { AuthService, AgentRole, AuthenticatedAgent, LocalPasswordAuthProvider } from './auth-service.js';
import { AuditService } from './audit-service.js';
import { requireSecret } from './secrets.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  databaseUrl?: string;
  redisUrl?: string;
  db?: Database;
  pubsub?: RedisPubSub;
  orchestrator?: {
    process: (req: any) => Promise<any>;
    guardrails?: any;
  };
  waitingCompanion?: WaitingCompanion;
  typingDelay?: TypingDelayOptions;
  enforceAuth?: boolean;
}

export async function buildGatewayServer(opts: ServerOptions = {}): Promise<{
  app: FastifyInstance;
  db: Database;
  pubsub: RedisPubSub;
  hub: WebSocketHub;
}> {
  const app = Fastify({ logger: false });
  // Fail-fast: di produksi COOKIE_SECRET wajib ada dan cukup panjang (lihat secrets.ts)
  await app.register(fastifyCookie, {
    secret: requireSecret('COOKIE_SECRET'),
  });
  AttachmentService.ensureStorageDirectory();

  // Dukungan parsing binary buffer untuk direct image upload
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  const db = opts.db || new Database(opts.databaseUrl);
  const pubsub = opts.pubsub || new RedisPubSub(opts.redisUrl);
  await pubsub.init();
  const hub = new WebSocketHub(db, pubsub);
  const studioService = new StudioService(db, opts.orchestrator);
  const waitingCompanion = opts.waitingCompanion;
  const auditService = new AuditService(db);
  const enforceAuth = opts.enforceAuth ?? (process.env.NODE_ENV === 'production' || process.env.ENFORCE_AUTH === 'true');

  // Helper: Ambil agent dari cookie httpOnly atau header Authorization
  const getSessionAgent = async (req: any): Promise<AuthenticatedAgent | null> => {
    let token = req.cookies?.[AuthService.SESSION_COOKIE_NAME];
    if (!token) {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      } else if (req.headers['x-agent-session']) {
        token = req.headers['x-agent-session'] as string;
      }
    }

    if (!token) return null;

    const tokenHash = AuthService.hashSessionToken(token);
    const sessionData = await db.getAgentSession(tokenHash);
    if (!sessionData) return null;

    return sessionData.agent;
  };

  // Middleware: Wajib sesi login yang sah
  const requireAgentAuth = async (req: any, reply: any) => {
    if (!enforceAuth) {
      if (!req.agent && (req.query?.agent_id || req.body?.agent_id)) {
        const ag = await db.getAgent(req.query?.agent_id || req.body?.agent_id);
        if (ag) req.agent = ag;
      }
      return;
    }

    const agent = await getSessionAgent(req);
    if (!agent) {
      return reply.code(401).send({
        error: 'Sesi login tidak sah atau telah berakhir. Silakan login terlebih dahulu.',
        code: 'UNAUTHORIZED',
      });
    }
    req.agent = agent;
  };

  // Middleware: Wajib peran tertentu (RBAC)
  const requireRole = (allowedRoles: AgentRole[]) => async (req: any, reply: any) => {
    if (!enforceAuth) return;

    const agent: AuthenticatedAgent = req.agent || (await getSessionAgent(req));
    if (!agent) {
      return reply.code(401).send({
        error: 'Sesi login tidak sah atau telah berakhir.',
        code: 'UNAUTHORIZED',
      });
    }
    req.agent = agent;

    if (!AuthService.isAllowedRole(agent.role, allowedRoles)) {
      return reply.code(403).send({
        error: `Akses ditolak: Peran '${agent.role}' tidak memiliki izin untuk tindakan ini. Diperlukan salah satu dari: ${allowedRoles.join(', ')}`,
        code: 'FORBIDDEN',
        required_roles: allowedRoles,
        current_role: agent.role,
      });
    }
  };

  // Hook mode bayangan (Shadow Mode - TASK-08) & Waiting Companion:
  // Bot memproses setiap pesan pemain dan menghasilkan jawaban langsung atau draf untuk panel agent
  if (opts.orchestrator) {
    hub.onPlayerMessage = async (
      conversationId: string,
      text: string,
      explicitCategory?: string,
      hasAttachment?: boolean
    ) => {
      try {
        const conv = await db.getConversation(conversationId);
        if (!conv) return;

        // Jika agen manusia sudah aktif menangani sesi, bot tidak membalas ke pemain
        if (conv.status === 'agent_active') {
          return;
        }

        // =========================================================================
        // Syarat 3: Jika pemain menulis "sudah saya kirim" / "ini fotonya"
        // tetapi TIDAK ADA attachment (hasAttachment = false), bot DILARANG mengulang
        // pertanyaan verbatim. Bot harus memberitahu bahwa file belum masuk dan
        // memandu cara melampirkannya menggunakan tombol lampiran (📎).
        // =========================================================================
        if (!hasAttachment && AttachmentService.isClaimingSentAttachment(text)) {
          await hub.broadcastTyping(conversationId, 'bot', true, conv.bot_persona || 'mira');
          await new Promise((r) => setTimeout(r, 600));

          const explanation = AttachmentService.getMissingAttachmentExplanation(
            conv.locale || 'id-ID',
            conv.bot_persona || 'mira'
          );
          const personaInfo = await db.getBotPersona(conv.bot_persona || 'mira', conv.locale);

          const savedMsg = await db.saveMessage({
            conversation_id: conversationId,
            sender_type: 'bot',
            sender_id: conv.bot_persona || 'mira',
            text: explanation,
            meta: {
              is_draft: false,
              auto_replied: true,
              bot_persona: conv.bot_persona,
              sender_name: personaInfo.display_name,
              avatar_url: personaInfo.avatar_url,
              needs_evidence: true,
              evidence_type: 'attachment',
            },
          });

          await hub.broadcastMessage(conversationId, savedMsg);
          await hub.broadcastTyping(conversationId, 'bot', false, conv.bot_persona || 'mira');
          return;
        }

        const typingDelayConfig: TypingDelayOptions = {
          enabled: true,
          msPerChar: 50,
          minMs: 800,
          maxMs: 3000,
          ...opts.typingDelay,
        };

        // =========================================================================
        // WAITING COMPANION (Status: 'handoff_queued')
        // Saat status handoff_queued, bot TIDAK BOLEH DIAM!
        // =========================================================================
        if (conv.status === 'handoff_queued') {
          if (waitingCompanion) {
            // (1) Munculkan indikator pengetikan bot saat mulai merespon
            await hub.broadcastTyping(conversationId, 'bot', true, conv.bot_persona || 'mira');
            const typingStart = Date.now();

            const companionRes = await waitingCompanion.processWaitingMessage({
              text,
              locale: conv.locale || 'id-ID',
              existingSlots: conv.page_context?.collected_slots || {},
              lastTargetSlot: conv.page_context?.current_slot,
              botPersona: conv.bot_persona || 'mira',
              handoffReason: conv.page_context?.handoff_reason,
            });

            // (5) Tulis seluruh data terkumpul ke handoffs.bot_summary
            await db.updateHandoffBotSummary(conversationId, companionRes.botSummary);

            // Update page_context (collected_slots, current_slot, waktu pesan)
            await db.updateConversationStage(
              conversationId,
              'escalation',
              companionRes.updatedSlots
            );
            if (companionRes.nextSlotToAsk) {
              await db.pool.query(
                `UPDATE conversations
                 SET page_context = jsonb_set(COALESCE(page_context, '{}'::jsonb), '{current_slot}', $1::jsonb, true)
                 WHERE id = $2`,
                [JSON.stringify(companionRes.nextSlotToAsk), conversationId]
              );
            }

            // (2) Terapkan jeda pengetikan alami sebelum mengirim
            if (typingDelayConfig.enabled !== false) {
              const targetDelay = calculateTypingDelay(
                companionRes.text.length,
                typingDelayConfig.msPerChar,
                typingDelayConfig.minMs,
                typingDelayConfig.maxMs
              );
              const elapsed = Date.now() - typingStart;
              const remaining = Math.max(0, targetDelay - elapsed);
              if (remaining > 0) {
                await new Promise((r) => setTimeout(r, remaining));
              }
            }

            const personaInfo = await db.getBotPersona(conv.bot_persona || 'mira', conv.locale);

            const isEvidenceSlot = companionRes.nextSlotToAsk === 'order_id' || companionRes.nextSlotToAsk === 'screenshot_proof';

            const savedMsg = await db.saveMessage({
              conversation_id: conversationId,
              sender_type: 'bot',
              sender_id: conv.bot_persona || 'mira',
              text: companionRes.text,
              meta: {
                is_draft: false,
                auto_replied: true,
                is_waiting_companion: true,
                bot_persona: conv.bot_persona,
                sender_name: personaInfo.display_name,
                avatar_url: personaInfo.avatar_url,
                stage: 'escalation',
                collected_slots: companionRes.updatedSlots,
                next_slot: companionRes.nextSlotToAsk,
                is_hard_trigger: companionRes.isHardTriggerTopic,
                needs_evidence: isEvidenceSlot,
                evidence_type: isEvidenceSlot ? 'attachment' : undefined,
              },
            });

            await hub.broadcastMessage(conversationId, savedMsg);

            // (3) Hentikan indikator pengetikan saat pesan terkirim
            await hub.broadcastTyping(conversationId, 'bot', false, conv.bot_persona || 'mira');
          }
          return;
        }

        // Syarat 4: Pastikan isi file attachment TIDAK PERNAH dikirim ke language model
        const history = await db.getMessages(conversationId, 20, false);
        const orchestratorHistory = history.map((m) => {
          const { safeText } = AttachmentService.sanitizeForLanguageModel(m.text, m.meta);
          return {
            sender_type: m.sender_type,
            text: safeText,
          };
        });

        const { safeText: safeLatestText } = AttachmentService.sanitizeForLanguageModel(text);

        const orchestrateReq = {
          conversation_id: conversationId,
          locale: conv.locale || (conv.market === 'ID' ? 'id-ID' : 'en'),
          market: conv.market || 'ID',
          stage: conv.stage || 'greeting',
          category: explicitCategory || conv.category || undefined,
          collected_slots: conv.page_context?.collected_slots || {},
          player: {
            uid: conv.player_uid,
            level: conv.page_context?.player_level,
            vip_tier: conv.page_context?.vip_tier,
            server: conv.page_context?.server,
          },
          page_context: conv.page_context || {},
          bot_persona: conv.bot_persona || undefined,
          history: orchestratorHistory,
        };

        // (5) JANGAN PERNAH munculkan indikator pengetikan saat bot tidak akan merespon pemain:
        // Misalnya jika pasar mematikan bot (hanya draf mode bayangan) atau pemicu keras yang langsung handoff
        const isMarketBotActive = await db.isMarketBotEnabled(orchestrateReq.market);
        const isHardTrigger = isHardTriggerMessage(
          text,
          orchestrateReq.locale,
          opts.orchestrator?.guardrails
        );

        let typingActive = false;
        let typingStartTime = Date.now();

        // (1) Segera siarkan event pengetikan jika bot memang akan merespon ke pemain
        if (isMarketBotActive && !isHardTrigger) {
          await hub.broadcastTyping(conversationId, 'bot', true, conv.bot_persona || 'mira');
          typingActive = true;
          typingStartTime = Date.now();
        }

        // (4) Eksekusi orchestrator dengan penanganan error dan timeout
        let result: any;
        try {
          const timeoutMs = 10000;
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('ORCHESTRATOR_TIMEOUT')), timeoutMs)
          );
          result = await Promise.race([
            opts.orchestrator!.process(orchestrateReq),
            timeoutPromise,
          ]);
        } catch (err: any) {
          console.error('[Orchestrator] Error or timeout during message processing:', err);
          if (typingActive) {
            await hub.broadcastTyping(conversationId, 'bot', false, conv.bot_persona || 'mira');
            typingActive = false;
          }

          // (4) Kirim pesan fallback graceful
          const fallbackText = getGracefulFallbackMessage(orchestrateReq.locale, conv.bot_persona || 'mira');
          const personaInfo = await db.getBotPersona(conv.bot_persona || 'mira', orchestrateReq.locale);
          const savedFallback = await db.saveMessage({
            conversation_id: conversationId,
            sender_type: 'bot',
            sender_id: conv.bot_persona || 'mira',
            text: fallbackText,
            meta: {
              is_draft: false,
              auto_replied: true,
              is_fallback: true,
              bot_persona: conv.bot_persona,
              sender_name: personaInfo.display_name,
              avatar_url: personaInfo.avatar_url,
            },
          });
          await hub.broadcastMessage(conversationId, savedFallback);
          return;
        }

        if (result && result.action === 'reply' && result.text) {
          // Update status tahap penanganan percakapan (Syarat 1 & Syarat 3)
          if (result.meta?.stage) {
            await db.updateConversationStage(
              conversationId,
              result.meta.stage,
              result.meta.collected_slots
            );
          }

          // Ambil identitas persona bot (spec/08-persona-bot.md)
          const personaInfo = await db.getBotPersona(conv.bot_persona || 'mira', orchestrateReq.locale);

          // Cek kelayakan auto-reply terbatas (TASK-09)
          const autoReplyCheck = await db.isAutoReplyAllowed(
            result.meta?.intent || '',
            orchestrateReq.locale,
            result.meta?.confidence ?? 0
          );

          console.log(
            `[AutoReply Evaluator] Conv: ${conversationId} | Persona: '${personaInfo.display_name}' (${conv.bot_persona}) | Intent: '${result.meta?.intent}' | Stage: '${result.meta?.stage}' | Conf: ${result.meta?.confidence} | Allowed: ${autoReplyCheck.allowed}${autoReplyCheck.allowed ? ' -> AUTO-REPLY DIKIRIM' : ` -> DRAF AGEN (${autoReplyCheck.reason})`}`
          );

          if (autoReplyCheck.allowed) {
            // (2) Tahan indikator selama orchestrator bekerja, lalu tambahkan natural delay proporsional
            if (typingDelayConfig.enabled !== false) {
              const targetDelay = calculateTypingDelay(
                result.text.length,
                typingDelayConfig.msPerChar,
                typingDelayConfig.minMs,
                typingDelayConfig.maxMs
              );
              const elapsed = Date.now() - typingStartTime;
              const remaining = Math.max(0, targetDelay - elapsed);
              if (remaining > 0) {
                await new Promise((r) => setTimeout(r, remaining));
              }
            }

            // =========================================================================
            // AUTO-REPLY LANGSUNG (TASK-09)
            // =========================================================================
            const savedMessage = await db.saveMessage({
              conversation_id: conversationId,
              sender_type: 'bot',
              sender_id: conv.bot_persona || 'mira',
              text: result.text,
              meta: {
                is_draft: false,
                auto_replied: true,
                bot_persona: conv.bot_persona,
                sender_name: personaInfo.display_name,
                avatar_url: personaInfo.avatar_url,
                intent: result.meta?.intent,
                confidence: result.meta?.confidence,
                stage: result.meta?.stage,
                collected_slots: result.meta?.collected_slots,
                current_slot: result.meta?.current_slot,
                emotion: result.meta?.emotion,
                sources: result.meta?.sources,
                tools_used: result.meta?.tools_used,
                locale_out: result.meta?.locale_out,
                guardrail_flags: result.meta?.guardrail_flags,
              },
            });

            // SYARAT 3: Catat di bot_feedback agar bisa ditinjau & ditandai salah oleh agen
            await db.saveBotFeedback({
              message_id: savedMessage.id,
              verdict: 'auto_replied',
              reviewer_id: null,
            });

            // Siarkan ke widget pemain DAN panel agent
            await hub.broadcastMessage(conversationId, savedMessage);

            // (3) Hentikan indikator pengetikan saat pesan terkirim
            if (typingActive) {
              await hub.broadcastTyping(conversationId, 'bot', false, conv.bot_persona || 'mira');
              typingActive = false;
            }
          } else {
            // Bukan auto-reply (Draf Mode Bayangan): Matikan indikator pengetikan di pemain
            if (typingActive) {
              await hub.broadcastTyping(conversationId, 'bot', false, conv.bot_persona || 'mira');
              typingActive = false;
            }

            // =========================================================================
            // DRAF MODE BAYANGAN (TASK-08)
            // =========================================================================
            const savedDraft = await db.saveMessage({
              conversation_id: conversationId,
              sender_type: 'bot',
              sender_id: conv.bot_persona || 'mira',
              text: result.text,
              meta: {
                is_draft: true,
                bot_persona: conv.bot_persona,
                sender_name: personaInfo.display_name,
                avatar_url: personaInfo.avatar_url,
                intent: result.meta?.intent,
                confidence: result.meta?.confidence,
                stage: result.meta?.stage,
                collected_slots: result.meta?.collected_slots,
                current_slot: result.meta?.current_slot,
                emotion: result.meta?.emotion,
                sources: result.meta?.sources,
                tools_used: result.meta?.tools_used,
                locale_out: result.meta?.locale_out,
                guardrail_flags: result.meta?.guardrail_flags,
                auto_reply_disallowed_reason: autoReplyCheck.reason,
              },
            });

            await hub.broadcastBotDraft(conversationId, savedDraft);
          }
        } else if (result && result.action === 'handoff') {
          // Bersihkan indikator jika masih aktif
          if (typingActive) {
            await hub.broadcastTyping(conversationId, 'bot', false, conv.bot_persona || 'mira');
            typingActive = false;
          }

          // Hard trigger / bot handoff: eskalasi status percakapan ke handoff_queued dan stage ke escalation
          await db.updateConversationStage(conversationId, 'escalation');
          const prevStatus = conv.status;
          await db.updateConversationStatus(conversationId, 'handoff_queued');

          if (waitingCompanion) {
            // (1) Hitung estimasi waktu tunggu antrean berdasarkan SLA pasar
            let waitMinutes = 10;
            if (conv.sla_due_at) {
              waitMinutes = Math.max(1, Math.round((new Date(conv.sla_due_at).getTime() - Date.now()) / 60000));
            } else {
              const due = new Date(Date.now() + 10 * 60 * 1000);
              await db.pool.query('UPDATE conversations SET sla_due_at = $1 WHERE id = $2', [due, conversationId]);
            }

            // (5 & 6) Format structured case file grouped by category for handoffs.bot_summary
            const activeCategory = conv.category || 'payment_topup';
            const categoryFields = await db.getCategoryFieldDefinitions(activeCategory);
            const allCollected = {
              ...(conv.page_context?.collected_slots || {}),
              ...(conv.collected_fields || {}),
            };
            const initialSummary = CategoryFieldService.buildStructuredCaseFile({
              category: activeCategory,
              fields: categoryFields,
              collected: allCollected,
              player: { uid: conv.player_uid, ...(conv.page_context?.player || {}) },
              reason: result.reason || 'bot_handoff',
              locale: orchestrateReq.locale,
            });

            const existingHandoff = await db.pool.query('SELECT id FROM handoffs WHERE conversation_id = $1', [conversationId]);
            if (existingHandoff.rows.length > 0) {
              await db.pool.query(
                `UPDATE handoffs SET reason = $1, bot_summary = $2, locale = $3 WHERE conversation_id = $4`,
                [result.reason || 'bot_handoff', initialSummary, orchestrateReq.locale, conversationId]
              );
            } else {
              await db.pool.query(
                `INSERT INTO handoffs (conversation_id, reason, bot_summary, locale, queued_at)
                 VALUES ($1, $2, $3, $4, now())`,
                [conversationId, result.reason || 'bot_handoff', initialSummary, orchestrateReq.locale]
              );
            }
            await hub.broadcastStatusChange(conversationId, prevStatus, 'handoff_queued');

            // (1) Segera akui keluhan pemain & informasikan estimasi waktu tunggu antrean
            const personaInfo = await db.getBotPersona(conv.bot_persona || 'mira', orchestrateReq.locale);
            const ackText = waitingCompanion.getImmediateHandoffAcknowledgement(
              result.reason || 'bot_handoff',
              orchestrateReq.locale,
              waitMinutes,
              conv.bot_persona || 'mira'
            );

            const savedAck = await db.saveMessage({
              conversation_id: conversationId,
              sender_type: 'bot',
              sender_id: conv.bot_persona || 'mira',
              text: ackText,
              meta: {
                is_draft: false,
                auto_replied: true,
                is_waiting_companion: true,
                bot_persona: conv.bot_persona,
                sender_name: personaInfo.display_name,
                avatar_url: personaInfo.avatar_url,
                estimated_wait_minutes: waitMinutes,
                stage: 'escalation',
              },
            });

            await hub.broadcastMessage(conversationId, savedAck);
          } else {
            const existingHandoff = await db.pool.query('SELECT id FROM handoffs WHERE conversation_id = $1', [conversationId]);
            if (existingHandoff.rows.length > 0) {
              await db.pool.query(
                `UPDATE handoffs SET reason = $1, bot_summary = $2, locale = $3 WHERE conversation_id = $4`,
                [result.reason || 'bot_handoff', result.bot_summary || '', orchestrateReq.locale, conversationId]
              );
            } else {
              await db.pool.query(
                `INSERT INTO handoffs (conversation_id, reason, bot_summary, locale, queued_at)
                 VALUES ($1, $2, $3, $4, now())`,
                [conversationId, result.reason || 'bot_handoff', result.bot_summary || '', orchestrateReq.locale]
              );
            }
            await hub.broadcastStatusChange(conversationId, prevStatus, 'handoff_queued');
          }
        }
      } catch (err) {
        console.error('Error in shadow bot draft processing:', err);
      }
    };
  }

  try {
    await db.ensureBotPersonasTable();
    await db.ensureInvestigationAndScheduleTables();
  } catch (err: any) {
    console.warn('[Gateway] Warning ensuring bot personas / investigation tables:', err.message);
  }

  // Enable CORS
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  await app.register(fastifyWebsocket);

  // Health check endpoints (spec/09-produksi.md Bagian 3 & 4)
  // Liveness probe
  app.get('/health/live', async () => {
    return { status: 'ok', service: 'chat-gateway', uptime: process.uptime() };
  });

  // Comprehensive health & readiness probe (Postgres + Redis)
  const healthCheckHandler = async (_req: any, reply: any) => {
    let dbStatus = 'unknown';
    let redisStatus = 'unknown';
    let isHealthy = true;

    try {
      await db.pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (err: any) {
      dbStatus = `error: ${err.message}`;
      isHealthy = false;
    }

    try {
      const pingOk = await pubsub.ping();
      redisStatus = pingOk ? 'connected' : 'error: ping failed';
      if (!pingOk) isHealthy = false;
    } catch (err: any) {
      redisStatus = `error: ${err.message}`;
      isHealthy = false;
    }

    const payload = {
      status: isHealthy ? 'ok' : 'unhealthy',
      service: 'chat-gateway',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      checks: {
        database: dbStatus,
        redis: redisStatus,
      },
    };

    if (!isHealthy) {
      return reply.code(503).send(payload);
    }
    return reply.send(payload);
  };

  app.get('/health', healthCheckHandler);
  app.get('/health/ready', healthCheckHandler);

  // Helper to locate static files in public directory regardless of cwd
  const resolvePublicFile = (filename: string): string | null => {
    const candidates = [
      path.resolve(process.cwd(), 'services/gateway/public', filename),
      path.resolve(process.cwd(), 'public', filename),
      path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../public', filename),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  };

  // Login page (Bagian 1 spec/09-produksi.md)
  const serveLogin = async (_req: any, reply: any) => {
    const p = resolvePublicFile('login.html');
    if (p) {
      return reply.type('text/html').send(fs.readFileSync(p, 'utf-8'));
    }
    return reply.code(404).send('Login page not found');
  };
  app.get('/login', serveLogin);
  app.get('/login.html', serveLogin);

  // Demo page
  const serveDemo = async (_req: any, reply: any) => {
    const p = resolvePublicFile('demo.html');
    if (p) {
      return reply.type('text/html').send(fs.readFileSync(p, 'utf-8'));
    }
    return reply.code(404).send('Demo page not found');
  };
  app.get('/demo', serveDemo);
  app.get('/demo.html', serveDemo);

  // Agent Panel page (dialihkan ke /login jika belum ada sesi sah)
  const serveAgentPanel = async (req: any, reply: any) => {
    if (enforceAuth) {
      const agent = await getSessionAgent(req);
      if (!agent) {
        return reply.redirect('/login?redirect=/agent');
      }
    }
    const p = resolvePublicFile('agent-panel.html');
    if (p) {
      return reply.type('text/html').send(fs.readFileSync(p, 'utf-8'));
    }
    return reply.code(404).send('Agent panel page not found');
  };
  app.get('/agent', serveAgentPanel);
  app.get('/agent-panel', serveAgentPanel);
  app.get('/agent-panel.html', serveAgentPanel);

  // AI Studio Console page (TASK-11, dialihkan ke /login jika belum ada sesi admin sah)
  const serveStudio = async (req: any, reply: any) => {
    if (enforceAuth) {
      const agent = await getSessionAgent(req);
      if (!agent || agent.role !== 'admin') {
        return reply.redirect('/login?redirect=/studio');
      }
    }
    const p = resolvePublicFile('studio.html');
    if (p) {
      return reply.type('text/html').send(fs.readFileSync(p, 'utf-8'));
    }
    return reply.code(404).send('AI Studio page not found');
  };
  app.get('/studio', serveStudio);
  app.get('/studio.html', serveStudio);

  // Logo & Static Asset Serving
  app.get('/logo-mark.png', async (_req, reply) => {
    const p = resolvePublicFile('logo-mark.png');
    if (p) return reply.type('image/png').send(fs.readFileSync(p));
    return reply.code(404).send('Logo mark not found');
  });
  app.get('/logo-full-light.png', async (_req, reply) => {
    const p = resolvePublicFile('logo-full-light.png');
    if (p) return reply.type('image/png').send(fs.readFileSync(p));
    return reply.code(404).send('Logo full light not found');
  });
  app.get('/logo-gaga.webp', async (_req, reply) => {
    const p = resolvePublicFile('logo-gaga.webp');
    if (p) return reply.type('image/webp').send(fs.readFileSync(p));
    return reply.code(404).send('Logo not found');
  });
  app.get('/logo-gaga-icon.png', async (_req, reply) => {
    const p = resolvePublicFile('logo-mark.png') || resolvePublicFile('logo-gaga-icon.png');
    if (p) return reply.type('image/png').send(fs.readFileSync(p));
    return reply.code(404).send('Logo icon not found');
  });
  app.get('/customer_chat_ui.jpg', async (_req, reply) => {
    const p = resolvePublicFile('customer_chat_ui.jpg');
    if (p) return reply.type('image/jpeg').send(fs.readFileSync(p));
    return reply.code(404).send('Image not found');
  });

  // Persona Avatars Serving (spec/08-persona-bot.md)
  const servePersonaAvatar = (filename: string) => async (_req: any, reply: any) => {
    const candidates = [
      resolvePublicFile(`assets/${filename}`),
      resolvePublicFile(filename),
      path.resolve(process.cwd(), 'assets', filename),
      path.resolve(process.cwd(), 'public/assets', filename),
      path.resolve(process.cwd(), 'public', filename),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        return reply.type('image/png').send(fs.readFileSync(p));
      }
    }
    return reply.code(404).send('Avatar not found');
  };

  app.get('/assets/agent-mira.png', servePersonaAvatar('agent-mira.png'));
  app.get('/assets/agent-reza.png', servePersonaAvatar('agent-reza.png'));
  app.get('/agent-mira.png', servePersonaAvatar('agent-mira.png'));
  app.get('/agent-reza.png', servePersonaAvatar('agent-reza.png'));
  app.get('/assets/agent-avatar.png', servePersonaAvatar('agent-mira.png'));
  app.get('/agent-avatar.png', servePersonaAvatar('agent-mira.png'));

  // REST: Import bot personas from CSV (spec/08-persona-bot.md)
  app.post('/v1/admin/personas/import', async (req: any, reply: any) => {
    const csvContent = req.body?.csv || (typeof req.body === 'string' ? req.body : null);
    if (!csvContent) {
      return reply.code(400).send({ error: 'Body CSV wajib disertakan', code: 'MISSING_CSV' });
    }
    const count = await db.importBotPersonasFromCsv(csvContent);
    return reply.send({ success: true, count });
  });

  // REST: Ambil daftar field investigasi untuk kategori tertentu (Syarat 1 & 2)
  app.get('/v1/categories/:category/fields', async (req: any, reply: any) => {
    const { category } = req.params;
    const fields = await db.getCategoryFieldDefinitions(category);
    return reply.send({ category, fields });
  });

  // REST: Ambil status investigasi saat ini untuk percakapan (Syarat 2)
  app.get('/v1/conversations/:id/investigation', async (req: any, reply: any) => {
    const { id } = req.params;
    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: 'Percakapan tidak ditemukan', code: 'CONVERSATION_NOT_FOUND' });
    }
    const category = conv.category || 'payment_topup';
    const fields = await db.getCategoryFieldDefinitions(category);
    const collected = conv.collected_fields || {};
    const nextField = CategoryFieldService.getNextFieldToAsk(category, fields, collected, conv.locale);
    const statuses: CollectedFieldStatus[] = fields.map((f) => ({
      key: f.field_key,
      label: f.labels[conv.locale] || f.labels['en'] || f.field_key,
      is_required: f.is_required,
      status: collected[f.field_key] ? 'collected' : 'pending',
      value: collected[f.field_key] || undefined,
      evidence_type: f.evidence_type,
    }));
    return reply.send({
      conversation_id: id,
      category,
      collected_fields: collected,
      fields: statuses,
      next_field: nextField,
    });
  });

  // REST: Upload lampiran (Syarat 4: MIME sniffing, EXIF stripping, size & count limit, storage outside web root, signed URL)
  app.post('/v1/attachments/upload', async (req: any, reply: any) => {
    try {
      let filesToProcess: Array<{ buffer: Buffer; filename: string }> = [];

      // Skenario A: Raw binary upload
      if (Buffer.isBuffer(req.body)) {
        const rawFilename = (req.headers['x-filename'] as string) || (req.query?.filename as string) || 'attachment.png';
        filesToProcess.push({ buffer: req.body, filename: rawFilename });
      } else if (req.body?.files && Array.isArray(req.body.files)) {
        // Skenario B: Batch JSON base64
        for (const f of req.body.files) {
          if (!f.file_base64) continue;
          const cleanB64 = f.file_base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
          const buf = Buffer.from(cleanB64, 'base64');
          filesToProcess.push({ buffer: buf, filename: f.filename || 'attachment.png' });
        }
      } else if (req.body?.file_base64) {
        // Skenario C: Single JSON base64
        const cleanB64 = req.body.file_base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
        const buf = Buffer.from(cleanB64, 'base64');
        filesToProcess.push({ buffer: buf, filename: req.body.filename || 'attachment.png' });
      } else {
        return reply.code(400).send({
          error: 'No file provided. Send file_base64 in JSON or binary buffer with image Content-Type',
          code: 'NO_FILE_PROVIDED',
        });
      }

      // 1. Batas jumlah file (Count limit): Maksimal 3 file
      if (filesToProcess.length > AttachmentService.MAX_FILES_PER_BATCH) {
        return reply.code(400).send({
          error: `Count limit exceeded. Maximum ${AttachmentService.MAX_FILES_PER_BATCH} files allowed per upload`,
          code: 'COUNT_LIMIT_EXCEEDED',
        });
      }

      if (filesToProcess.length === 0) {
        return reply.code(400).send({
          error: 'No valid file data decoded',
          code: 'EMPTY_FILE',
        });
      }

      const baseUrl = `${req.protocol}://${req.hostname}`;
      const results: AttachmentUploadResult[] = [];

      for (const item of filesToProcess) {
        // 2. Batas ukuran (Size limit): Maksimal 5MB
        if (item.buffer.length > AttachmentService.MAX_FILE_SIZE_BYTES) {
          return reply.code(413).send({
            error: `File ${item.filename} exceeds maximum allowed size of 5MB`,
            code: 'FILE_TOO_LARGE',
          });
        }

        // 3. MIME Sniffing: Cek magic bytes buffer
        const sniff = AttachmentService.sniffMimeType(item.buffer);
        if (!sniff) {
          return reply.code(400).send({
            error: `File ${item.filename} has unsupported or invalid MIME type. Only JPEG, PNG, and WebP are allowed`,
            code: 'UNSUPPORTED_MEDIA_TYPE',
          });
        }

        // 4. EXIF stripping + Storage di luar web root + Signed URL
        const saved = await AttachmentService.saveAttachment(item.buffer, item.filename, baseUrl);
        results.push(saved);
      }

      // Jika ada conversation_id, otomatis penuhi field bukti jika kategori aktif memiliki field attachment
      const conversationId = req.body?.conversation_id || req.query?.conversation_id;
      if (conversationId && results.length > 0) {
        const conv = await db.getConversation(conversationId);
        if (conv?.category) {
          const fields = await db.getCategoryFieldDefinitions(conv.category);
          const { updated, satisfiedKey } = CategoryFieldService.satisfyAttachmentEvidence(
            fields,
            conv.collected_fields || {},
            results[0].signed_url
          );
          if (satisfiedKey) {
            await db.updateConversationCollectedFields(conversationId, updated);
          }
        }
      }

      return reply.code(201).send({
        success: true,
        count: results.length,
        attachments: results,
        attachment: results[0],
      });
    } catch (err: any) {
      console.error('[Upload Endpoint] Error handling file upload:', err);
      return reply.code(400).send({
        error: err.message || 'File upload failed',
        code: 'UPLOAD_FAILED',
      });
    }
  });

  // REST: Akses file lampiran dengan verifikasi Signed URL berbatas waktu
  app.get('/v1/attachments/:fileId', async (req: any, reply: any) => {
    const { fileId } = req.params;
    const { filename, expires, token } = req.query as {
      filename?: string;
      expires?: string;
      token?: string;
    };

    if (!filename || !expires || !token) {
      return reply.code(403).send({
        error: 'Missing required signature parameters (filename, expires, token)',
        code: 'FORBIDDEN',
      });
    }

    // Verifikasi HMAC dan masa berlaku
    const verification = AttachmentService.verifySignedUrl(
      fileId,
      filename,
      parseInt(expires, 10),
      token
    );

    if (!verification.valid) {
      return reply.code(403).send({
        error: verification.reason === 'URL_EXPIRED' ? 'Attachment signed URL has expired' : 'Invalid attachment signature',
        code: 'FORBIDDEN',
      });
    }

    const filePath = AttachmentService.getAttachmentFilePath(fileId);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({
        error: 'Attachment file not found on server',
        code: 'NOT_FOUND',
      });
    }

    const fileBuffer = await fs.promises.readFile(filePath);
    const sniff = AttachmentService.sniffMimeType(fileBuffer);
    const contentType = sniff ? sniff.mimeType : 'application/octet-stream';

    // Catat pembukaan lampiran oleh agen di audit_log (spec/09-produksi.md)
    const sessionAgent = await getSessionAgent(req);
    if (sessionAgent) {
      await auditService.log({
        actorId: sessionAgent.id,
        action: 'attachment.view',
        target: fileId,
        detail: { filename, content_type: contentType },
      });
    }

    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fileBuffer);
  });

  // WebSocket endpoint: /v1/socket
  app.get('/v1/socket', { websocket: true }, (socket, req) => {
    const query = (req.query as Record<string, string>) || {};
    const token = query.token || (req.headers['authorization'] as string);
    const isAgent = query.agent === 'true';

    // Verifikasi auth
    verifyGameSessionToken(token)
      .then((player) => {
        hub.registerClient(socket, player, isAgent);
        if (query.conversation_id) {
          hub.joinRoom(query.conversation_id, socket);
        }

        socket.on('message', async (data) => {
          try {
            await hub.handleInboundMessage(socket, data.toString());
          } catch (err: any) {
            socket.send(
              JSON.stringify({
                event: 'error',
                code: 'INTERNAL_ERROR',
                message: err?.message || 'Terjadi kesalahan saat memproses pesan',
              })
            );
          }
        });
      })
      .catch((err) => {
        socket.send(
          JSON.stringify({
            event: 'error',
            code: 'AUTH_FAILED',
            message: err.message || 'Autentikasi gagal',
          })
        );
        socket.close(1008, 'Authentication failed');
      });
  });

  // REST: Transisi status percakapan
  app.post<{
    Params: { id: string };
    Body: {
      to: ConversationStatus;
      resolution_reason?: ResolutionReason;
      ticket_id?: string;
      agent_id?: string;
    };
  }>('/v1/conversations/:id/transition', async (req, reply) => {
    const { id } = req.params;
    const { to, resolution_reason, ticket_id, agent_id } = req.body || {};

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    try {
      const updated = await db.updateConversationStatus(
        id,
        to,
        resolution_reason,
        ticket_id,
        agent_id
      );

      // Siarkan pergantian status
      await hub.broadcastStatusChange(id, conv.status, to, resolution_reason, ticket_id);

      return reply.send(updated);
    } catch (err: any) {
      if (err instanceof InvalidStatusTransitionError) {
        return reply.code(400).send({
          error: err.message,
          code: err.code,
          from: err.from,
          to: err.to,
        });
      }
      if (err instanceof InvalidResolutionReasonError) {
        return reply.code(400).send({
          error: err.message,
          code: err.code,
        });
      }
      return reply.code(500).send({ error: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  // =========================================================================
  // REST ENDPOINTS: AUTENTIKASI PANEL AGENT & AI STUDIO (spec/09-produksi.md)
  // =========================================================================

  // REST: Login agen/supervisor/admin dengan email dan kata sandi (Argon2id + httpOnly cookie)
  app.post<{
    Body: { email?: string; password?: string };
  }>('/v1/auth/login', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return reply.code(400).send({
        error: 'Email dan kata sandi wajib diisi',
        code: 'MISSING_CREDENTIALS',
      });
    }

    const provider = new LocalPasswordAuthProvider((em) => db.getAgentByEmail(em));
    try {
      const agent = await provider.authenticate({ email, password });
      const sessionToken = AuthService.generateSessionToken();
      const tokenHash = AuthService.hashSessionToken(sessionToken);
      const expiresAt = new Date(Date.now() + AuthService.SESSION_DURATION_SECONDS * 1000);

      await db.createAgentSession(agent.id, tokenHash, expiresAt);
      await db.updateAgentLastLogin(agent.id);

      // Set cookie httpOnly & secure
      reply.setCookie(AuthService.SESSION_COOKIE_NAME, sessionToken, AuthService.getCookieOptions());

      // Catat audit_log
      await auditService.log({
        actorId: agent.id,
        action: 'auth.login',
        target: agent.id,
        detail: { email: agent.email, role: agent.role },
      });

      return reply.send({
        success: true,
        session_token: sessionToken,
        agent: {
          id: agent.id,
          email: agent.email,
          name: agent.name,
          role: agent.role,
          locales: agent.locales,
          external_id: agent.external_id,
          last_login_at: new Date(),
        },
      });
    } catch (err: any) {
      return reply.code(401).send({
        error: err.message || 'Email atau kata sandi tidak sesuai',
        code: 'AUTH_FAILED',
      });
    }
  });

  // REST: Logout agen
  app.post('/v1/auth/logout', async (req, reply) => {
    let token = req.cookies?.[AuthService.SESSION_COOKIE_NAME];
    if (!token) {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      } else if (req.headers['x-agent-session']) {
        token = req.headers['x-agent-session'] as string;
      }
    }

    if (token) {
      const tokenHash = AuthService.hashSessionToken(token);
      const sessionData = await db.getAgentSession(tokenHash);
      if (sessionData) {
        await auditService.log({
          actorId: sessionData.agent.id,
          action: 'auth.logout',
          target: sessionData.agent.id,
          detail: { email: sessionData.agent.email },
        });
      }
      await db.deleteAgentSession(tokenHash);
    }

    reply.clearCookie(AuthService.SESSION_COOKIE_NAME, { path: '/' });
    return reply.send({ success: true, message: 'Berhasil keluar' });
  });

  // REST: Info akun yang sedang login (identitas dari sesi, bukan pilihan di UI)
  app.get('/v1/auth/me', async (req, reply) => {
    const agent = await getSessionAgent(req);
    if (!agent) {
      return reply.code(401).send({
        error: 'Sesi login tidak sah atau telah berakhir',
        code: 'UNAUTHORIZED',
      });
    }
    return reply.send({ agent });
  });

  // REST: Audit Log (Hanya supervisor & admin)
  app.get<{
    Querystring: { limit?: string; action?: string; actor_id?: string };
  }>('/v1/audit-logs', { preHandler: [requireAgentAuth, requireRole(['supervisor', 'admin'])] }, async (req, reply) => {
    const limit = parseInt(req.query?.limit || '100', 10);
    const logs = await auditService.getRecentLogs(limit, req.query?.action, req.query?.actor_id);
    return reply.send({ count: logs.length, logs });
  });

  // REST: Ambil daftar agent
  app.get('/v1/agents', async (_req, reply) => {
    const agents = await db.listAgents();
    return reply.send({ count: agents.length, agents });
  });

  // REST: Antrean per bahasa / agent (terurut sisa SLA, ditolak jika tidak ada sesi sah)
  app.get<{
    Querystring: {
      agent_id?: string;
      locale?: string;
      status?: string;
    };
  }>('/v1/queue', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { locale, status } = req.query || {};
    const agent_id = req.query?.agent_id || req.agent?.id;
    try {
      const queue = await db.getQueue({ agentId: agent_id, locale, status: status as any });
      return reply.send({ count: queue.length, queue });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message, code: 'QUEUE_ERROR' });
    }
  });

  // REST: Klaim percakapan oleh agent (Atomic locking, identitas berasal dari sesi login)
  app.post<{
    Params: { id: string };
    Body: { agent_id?: string };
  }>('/v1/conversations/:id/claim', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { id } = req.params;
    const agent_id = req.agent?.id || req.body?.agent_id;

    if (!agent_id) {
      return reply.code(400).send({ error: 'agent_id wajib disertakan atau harus terautentikasi', code: 'MISSING_AGENT_ID' });
    }

    try {
      const convBefore = await db.getConversation(id);
      const prevStatus = convBefore?.status || 'handoff_queued';
      const updated = await db.claimConversationAtomic(id, agent_id);

      let agentName = req.agent?.name || 'Customer Support';
      if (!req.agent) {
        const agRes = await db.pool.query('SELECT name FROM agents WHERE id = $1', [agent_id]);
        if (agRes.rows.length > 0) {
          agentName = agRes.rows[0].name;
        }
      }

      await hub.broadcastStatusChange(id, prevStatus, 'agent_active', undefined, undefined, agentName, agent_id);

      // Catat di audit_log
      await auditService.log({
        actorId: agent_id,
        action: 'conversation.claim',
        target: id,
        detail: { prev_status: prevStatus, new_status: 'agent_active', agent_name: agentName },
      });

      return reply.send(updated);
    } catch (err: any) {
      const statusCode = err.statusCode || 400;
      return reply.code(statusCode).send({
        error: err.message,
        code: err.code || 'CLAIM_FAILED',
      });
    }
  });

  // REST: Status update berkala saat pemain diam dalam antrean (Syarat 4: Maksimal 3 menit sekali)
  app.post<{
    Params: { id: string };
    Body: { force?: boolean };
  }>('/v1/conversations/:id/waiting-status-update', async (req, reply) => {
    const { id } = req.params;
    const { force = false } = req.body || {};

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    if (conv.status !== 'handoff_queued') {
      return reply.code(400).send({
        error: `Status percakapan bukan 'handoff_queued' (saat ini: ${conv.status})`,
        code: 'INVALID_STATUS',
      });
    }

    const lastUpdateAt = conv.page_context?.last_status_update_at;
    const eligible = force || waitingCompanion.canSendQueueStatusUpdate(lastUpdateAt);

    if (!eligible) {
      return reply.code(429).send({
        sent: false,
        throttled: true,
        message: 'Pembaruan status antrean hanya boleh dikirim maksimal 3 menit sekali.',
        last_status_update_at: lastUpdateAt,
      });
    }

    const updateText = waitingCompanion.getQueueStatusUpdateMessage(conv.locale, conv.bot_persona || 'mira');
    const personaInfo = await db.getBotPersona(conv.bot_persona || 'mira', conv.locale);

    const savedMsg = await db.saveMessage({
      conversation_id: id,
      sender_type: 'bot',
      sender_id: conv.bot_persona || 'mira',
      text: updateText,
      meta: {
        is_draft: false,
        auto_replied: true,
        is_status_update: true,
        bot_persona: conv.bot_persona,
        sender_name: personaInfo.display_name,
        avatar_url: personaInfo.avatar_url,
        stage: 'escalation',
      },
    });

    await db.pool.query(
      `UPDATE conversations
       SET page_context = jsonb_set(COALESCE(page_context, '{}'::jsonb), '{last_status_update_at}', $1::jsonb, true)
       WHERE id = $2`,
      [JSON.stringify(new Date().toISOString()), id]
    );

    await hub.broadcastMessage(id, savedMsg);
    return reply.send({ sent: true, message: savedMsg });
  });

  // REST: Agent kirim balasan pesan (hanya agent terautentikasi yang boleh mengirim sebagai agent)
  app.post<{
    Params: { id: string };
    Body: {
      text: string;
      sender_id?: string;
      sender_type?: 'agent' | 'system';
      translated?: boolean;
    };
  }>('/v1/conversations/:id/messages', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { id } = req.params;
    const { text, sender_id, sender_type = 'agent', translated = false } = req.body || {};

    if (!text || text.trim() === '') {
      return reply.code(400).send({ error: 'Teks pesan tidak boleh kosong', code: 'EMPTY_TEXT' });
    }

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    if (conv.status === 'resolved') {
      return reply.code(400).send({
        error: 'Percakapan sudah ditutup, tidak dapat mengirim pesan baru',
        code: 'CONVERSATION_RESOLVED',
      });
    }

    const effectiveSenderId = req.agent?.id || sender_id;

    // Jika agent membalas pada sesi belum terklaim, lakukan auto-claim atomik
    if (sender_type === 'agent' && effectiveSenderId && !conv.assigned_agent_id) {
      try {
        const prevStatus = conv.status;
        await db.claimConversationAtomic(id, effectiveSenderId);
        await hub.broadcastStatusChange(id, prevStatus, 'agent_active');
      } catch {}
    }

    const saved = await db.saveMessage({
      conversation_id: id,
      sender_type,
      sender_id: effectiveSenderId,
      text,
      translated,
    });

    // Catat audit_log jika agen mengirim pesan
    if (sender_type === 'agent') {
      await auditService.log({
        actorId: effectiveSenderId,
        action: 'message.send',
        target: saved.id,
        detail: {
          conversation_id: id,
          text_snippet: text.slice(0, 100),
          translated,
        },
      });
    }

    // Siarkan ke seluruh instance via Redis Pub/Sub
    await pubsub.publish(id, {
      event: 'message',
      conversation_id: id,
      message_id: saved.id,
      sender_type: saved.sender_type,
      sender_id: saved.sender_id || undefined,
      sender_name: sender_type === 'agent' ? (req.agent?.name || 'Support Agent') : 'System',
      text: saved.text,
      created_at: saved.created_at.toISOString(),
      translated: saved.translated,
    });

    // (3 & 6) Hentikan indikator pengetikan saat pesan agen terkirim
    if (sender_type === 'agent') {
      await hub.broadcastTyping(id, 'agent', false);
    }

    return reply.code(201).send(saved);
  });

  // REST: Indikator pengetikan agen manusia (Syarat 6)
  app.post<{
    Params: { id: string };
    Body: { is_typing?: boolean; agent_name?: string };
  }>('/v1/conversations/:id/typing', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { id } = req.params;
    const { is_typing = true, agent_name } = req.body || {};

    let resolvedName = agent_name || req.agent?.name;
    if (!resolvedName) {
      const conv = await db.getConversation(id);
      if (conv?.assigned_agent_id) {
        const agRes = await db.pool.query('SELECT name FROM agents WHERE id = $1', [conv.assigned_agent_id]);
        if (agRes.rows.length > 0) resolvedName = agRes.rows[0].name;
      }
    }

    await hub.broadcastTyping(
      id,
      'agent',
      is_typing,
      undefined,
      resolvedName || 'Support Agent',
      '/assets/agent-avatar.png'
    );
    return reply.send({ ok: true, is_typing });
  });

  // REST: Selesaikan percakapan (resolve)
  app.post<{
    Params: { id: string };
    Body: {
      resolution_reason?: ResolutionReason;
      ticket_id?: string;
    };
  }>('/v1/conversations/:id/resolve', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { id } = req.params;
    const { resolution_reason = 'agent_resolved', ticket_id } = req.body || {};

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    try {
      const updated = await db.updateConversationStatus(
        id,
        'resolved',
        resolution_reason,
        ticket_id
      );
      await hub.broadcastStatusChange(id, conv.status, 'resolved', resolution_reason, ticket_id);

      // Catat di audit_log
      await auditService.log({
        actorId: req.agent?.id || null,
        action: 'conversation.resolve',
        target: id,
        detail: { resolution_reason, ticket_id, previous_status: conv.status },
      });

      return reply.send(updated);
    } catch (err: any) {
      if (err instanceof InvalidStatusTransitionError) {
        return reply.code(400).send({
          error: err.message,
          code: err.code,
          from: err.from,
          to: err.to,
        });
      }
      return reply.code(400).send({ error: err.message, code: 'TRANSITION_FAILED' });
    }
  });

  // REST: Ganti persona bot percakapan (Mira / Reza)
  app.post<{
    Params: { id: string };
    Body: { persona: string };
  }>('/v1/conversations/:id/persona', async (req, reply) => {
    const { id } = req.params;
    const { persona } = req.body || {};
    if (!persona) {
      return reply.code(400).send({ error: 'persona wajib diisi (mira atau reza)', code: 'MISSING_PERSONA' });
    }
    const updated = await db.updateConversationPersona(id, persona);
    if (!updated) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }
    const personaInfo = await db.getBotPersona(updated.bot_persona || 'mira', updated.locale);
    return reply.send({
      success: true,
      conversation_id: id,
      bot_persona: updated.bot_persona,
      bot_name: personaInfo.display_name,
      bot_avatar: personaInfo.avatar_url,
    });
  });

  // REST: Set kategori taksonomi percakapan
  app.post<{
    Params: { id: string };
    Body: { category: string; subcategory?: string };
  }>('/v1/conversations/:id/category', async (req, reply) => {
    const { id } = req.params;
    const { category, subcategory } = req.body || {};
    if (!category) {
      return reply.code(400).send({ error: 'category wajib diisi', code: 'MISSING_CATEGORY' });
    }
    const updated = await db.updateConversationCategory(id, category, subcategory);
    if (!updated) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }
    return reply.send({
      success: true,
      conversation_id: id,
      category: updated.category,
      subcategory: updated.subcategory,
    });
  });

  // REST: Ambil riwayat pesan
  app.get<{
    Params: { id: string };
    Querystring: { include_drafts?: string };
  }>('/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params;
    const includeDrafts = req.query?.include_drafts === 'true';
    const messages = await db.getMessages(id, 50, includeDrafts);
    const conv = await db.getConversation(id);
    const persona = conv?.bot_persona || 'mira';
    const locale = conv?.locale || 'id-ID';
    const personaInfo = await db.getBotPersona(persona, locale);

    const enriched = messages.map((m) => {
      let senderName = m.sender_name;
      let avatarUrl = (m as any).avatar_url;
      if (m.sender_type === 'bot') {
        senderName = personaInfo.display_name;
        avatarUrl = personaInfo.avatar_url;
      } else if (m.sender_type === 'player') {
        senderName = 'Player';
      } else if (m.sender_type === 'agent') {
        senderName = m.sender_name || 'Support Agent';
        avatarUrl = '/assets/agent-avatar.png';
      }
      return {
        ...m,
        sender_name: senderName,
        avatar_url: avatarUrl,
        bot_persona: persona,
      };
    });

    return reply.send({
      conversation_id: id,
      bot_persona: persona,
      bot_name: personaInfo.display_name,
      bot_avatar: personaInfo.avatar_url,
      messages: enriched,
    });
  });

  // REST: Ambil draf bot untuk suatu percakapan (Mode Bayangan - TASK-08)
  app.get<{
    Params: { id: string };
  }>('/v1/conversations/:id/drafts', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { id } = req.params;
    const drafts = await db.getDraftMessages(id);
    return reply.send({ conversation_id: id, drafts });
  });

  // REST: Simpan feedback agent terhadap draf bot (Mode Bayangan - TASK-08)
  app.post<{
    Params: { id: string };
    Body: {
      verdict: 'accepted' | 'edited' | 'rejected' | 'auto_replied';
      corrected_text?: string;
      reviewer_id?: string;
    };
  }>('/v1/messages/:id/feedback', { preHandler: [requireAgentAuth] }, async (req: any, reply) => {
    const { id } = req.params;
    const { verdict, corrected_text } = req.body || {};
    const reviewer_id = req.agent?.id || req.body?.reviewer_id;

    if (!['accepted', 'edited', 'rejected', 'auto_replied'].includes(verdict)) {
      return reply.code(400).send({
        error: "Verdict harus bernilai 'accepted', 'edited', 'rejected', atau 'auto_replied'",
        code: 'INVALID_VERDICT',
      });
    }

    if (verdict === 'edited' && (!corrected_text || corrected_text.trim() === '')) {
      return reply.code(400).send({
        error: "corrected_text wajib diisi jika verdict bernilai 'edited'",
        code: 'MISSING_CORRECTED_TEXT',
      });
    }

    try {
      const feedback = await db.saveBotFeedback({
        message_id: id,
        verdict,
        corrected_text: verdict === 'edited' ? corrected_text : null,
        reviewer_id,
      });
      return reply.code(201).send(feedback);
    } catch (err: any) {
      return reply.code(400).send({
        error: err?.message || 'Gagal menyimpan feedback draf bot',
        code: 'SAVE_FEEDBACK_ERROR',
      });
    }
  });

  // REST: Laporan penggunaan draf tanpa edit per intent dan per locale (Khusus supervisor & admin)
  app.get('/v1/reports/draft-usage', { preHandler: [requireAgentAuth, requireRole(['supervisor', 'admin'])] }, async (_req: any, reply) => {
    const report = await db.getDraftUsageReport();
    return reply.send({
      generated_at: new Date().toISOString(),
      total_categories: report.length,
      report,
    });
  });

  // =========================================================================
  // REST ENDPOINTS: KONSOL AI STUDIO (TASK-11, Khusus Peran ADMIN)
  // =========================================================================

  // REST: Metrik Studio per locale (volume, containment, CSAT, draf usage)
  app.get('/v1/studio/metrics', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (_req: any, reply) => {
    const data = await studioService.getMetrics();
    return reply.send(data);
  });

  // REST: Daftar Sumber Pengetahuan (KB Documents & Canned Responses)
  app.get<{
    Querystring: { locale?: string; is_policy?: string };
  }>('/v1/studio/knowledge-base', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (req: any, reply) => {
    const { locale, is_policy } = req.query || {};
    const data = await studioService.getKnowledgeBaseList({
      locale,
      is_policy: is_policy !== undefined ? is_policy === 'true' : undefined,
    });
    return reply.send(data);
  });

  // REST: Status Kelengkapan Pagar Pengaman per Bahasa
  app.get('/v1/studio/guardrails/status', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (_req: any, reply) => {
    const data = await studioService.getGuardrailStatus();
    return reply.send(data);
  });

  // REST: Daftar Pemicu Handoff (Hard & Soft Triggers) + Statistik
  app.get('/v1/studio/handoff-triggers', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (_req: any, reply) => {
    const data = await studioService.getHandoffTriggers();
    return reply.send(data);
  });

  // REST: Daftar Aturan Operasional & Terkunci
  app.get('/v1/studio/rules', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (_req: any, reply) => {
    const rules = studioService.getRules();
    return reply.send({ count: rules.length, rules });
  });

  // REST: Ubah Status Aturan (Wajib menolak HTTP 403 jika aturan terkunci)
  app.patch<{
    Params: { key: string };
    Body: { enabled: boolean };
  }>('/v1/studio/rules/:key', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (req: any, reply) => {
    const { key } = req.params;
    const { enabled } = req.body || {};

    try {
      const updated = studioService.updateRule(key, { enabled });

      // Catat di audit_log
      await auditService.log({
        actorId: req.agent?.id || null,
        action: 'settings.rule_toggle',
        target: key,
        detail: { enabled },
      });

      return reply.send(updated);
    } catch (err: any) {
      if (err instanceof LockedRuleImmutableError) {
        return reply.code(403).send({
          error: err.message,
          code: err.code,
          rule_key: err.ruleKey,
        });
      }
      const status = err.statusCode || 400;
      return reply.code(status).send({
        error: err.message,
        code: err.code || 'UPDATE_RULE_ERROR',
      });
    }
  });

  // REST: Ruang Uji Coba (Playground Simulator Dry-Run)
  app.post<{
    Body: {
      message: string;
      locale: string;
      player?: { uid?: string; level?: number; vip_tier?: number; server?: string };
    };
  }>('/v1/studio/playground/simulate', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (req: any, reply) => {
    try {
      const sim = await studioService.simulatePlayground(
        req.body || { message: '', locale: 'en' }
      );
      return reply.send(sim);
    } catch (err: any) {
      const status = err.statusCode || 400;
      return reply.code(status).send({
        error: err.message,
        code: err.code || 'PLAYGROUND_SIMULATION_ERROR',
      });
    }
  });

  // REST: Ambil Daftar Aturan Auto-Reply per Intent per Locale beserta Metrik (TASK-09)
  app.get('/v1/studio/auto-reply-rules', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (_req: any, reply) => {
    try {
      const data = await studioService.getAutoReplyRulesWithMetrics();
      return reply.send(data);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({
        error: err.message,
        code: err.code || 'AUTO_REPLY_RULES_ERROR',
      });
    }
  });

  // REST: Ubah Status Auto-Reply per Intent per Locale (TASK-09)
  app.put<{
    Body: {
      intent: string;
      locale: string;
      is_enabled: boolean;
      min_confidence?: number;
    };
  }>('/v1/studio/auto-reply-rules', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (req: any, reply) => {
    const { intent, locale, is_enabled, min_confidence } = req.body || {};
    if (!intent || !locale || is_enabled === undefined) {
      return reply.code(400).send({
        error: 'intent, locale, dan is_enabled wajib disertakan.',
        code: 'INVALID_REQUEST',
      });
    }

    try {
      const result = await studioService.toggleAutoReplyRule({
        intent,
        locale,
        is_enabled,
        min_confidence,
      });

      // Catat di audit_log
      await auditService.log({
        actorId: req.agent?.id || null,
        action: 'settings.auto_reply',
        target: `${intent}:${locale}`,
        detail: { is_enabled, min_confidence },
      });

      return reply.send(result);
    } catch (err: any) {
      const status = err.statusCode || 400;
      return reply.code(status).send({
        error: err.message,
        code: err.code || 'UPDATE_AUTO_REPLY_ERROR',
      });
    }
  });

  // REST: Ubah Status Bot Pasar (markets.is_bot_enabled)
  app.put<{
    Params: { code: string };
    Body: { is_bot_enabled: boolean };
  }>('/v1/studio/markets/:code/bot-status', { preHandler: [requireAgentAuth, requireRole(['admin'])] }, async (req: any, reply) => {
    const { code } = req.params;
    const { is_bot_enabled } = req.body || {};

    if (is_bot_enabled === undefined) {
      return reply.code(400).send({
        error: 'is_bot_enabled wajib disertakan.',
        code: 'INVALID_REQUEST',
      });
    }

    if (is_bot_enabled) {
      const marketRes = await db.pool.query(
        `SELECT code, default_locale FROM markets WHERE code = $1`,
        [code]
      );
      if (marketRes.rows.length === 0) {
        return reply.code(404).send({
          error: `Pasar '${code}' tidak ditemukan.`,
          code: 'MARKET_NOT_FOUND',
        });
      }
      const locale = marketRes.rows[0].default_locale;
      const safetyRes = await db.pool.query(
        `SELECT count(*)::int AS cnt FROM guardrail_phrases WHERE rule_key = 'bahaya_diri' AND locale = $1`,
        [locale]
      );
      if ((safetyRes.rows[0]?.cnt || 0) === 0) {
        return reply.code(400).send({
          error: `Tidak dapat mengaktifkan bot pasar '${code}': Frasa pengaman wajib 'bahaya_diri' untuk locale '${locale}' belum lengkap.`,
          code: 'GUARDRAIL_INCOMPLETE',
        });
      }
    }

    await db.setMarketBotStatus(code, is_bot_enabled);

    // Catat di audit_log
    await auditService.log({
      actorId: req.agent?.id || null,
      action: 'settings.market_bot',
      target: code,
      detail: { is_bot_enabled },
    });

    return reply.send({
      code,
      is_bot_enabled,
      message: `Status bot pasar ${code} berhasil diperbarui menjadi ${is_bot_enabled}.`,
    });
  });

  return { app, db, pubsub, hub, studioService, auditService };
}

