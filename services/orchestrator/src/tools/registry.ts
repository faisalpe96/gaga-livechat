export interface VerifiedPlayer {
  uid: string;
  server?: string;
  level?: number;
  vip_tier?: number;
}

export interface ToolExecutionContext {
  verifiedPlayer: VerifiedPlayer;
  conversationId: string;
  locale: string;
}

export interface ToolCallResult {
  tool_name: string;
  player_uid_used: string;
  result: any;
  success: boolean;
  error?: string;
}

export class ToolRegistry {
  // Mock data store untuk simulasi API game
  private mockTransactions: Map<string, any> = new Map();
  private mockEventClaims: Map<string, any> = new Map();

  // Audit log untuk verifikasi pengujian
  public executionLog: ToolCallResult[] = [];

  constructor() {
    // Inisialisasi data simulasi
    this.mockTransactions.set('order_123', {
      order_id: 'order_123',
      amount: '500 THB',
      status: 'success',
      item: '600 Diamonds',
      created_at: '2026-09-07T10:00:00Z',
    });
  }

  /**
   * Eksekusi tool dengan penegakan keamanan:
   * 1. player_uid TIDAK PERNAH diambil dari argumen model atau teks pemain, melainkan disuntikkan dari sesi terverifikasi.
   * 2. grant_compensation dan freeze_account DITOLAK KERAS.
   */
  async executeTool(
    toolName: string,
    rawArgs: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolCallResult> {
    const verifiedUid = context.verifiedPlayer.uid;

    // 1. Larangan pemanggilan tool terlarang
    if (toolName === 'grant_compensation') {
      const err = 'Tool grant_compensation dimatikan di fase awal dan dilarang untuk dipanggil.';
      const res = { tool_name: toolName, player_uid_used: verifiedUid, result: null, success: false, error: err };
      this.executionLog.push(res);
      throw new Error(err);
    }

    if (toolName === 'freeze_account') {
      const err = 'Tool freeze_account tidak diizinkan dan dilarang untuk dipanggil.';
      const res = { tool_name: toolName, player_uid_used: verifiedUid, result: null, success: false, error: err };
      this.executionLog.push(res);
      throw new Error(err);
    }

    // 2. Eksekusi tool baca yang sah
    if (toolName === 'get_transaction') {
      const orderId = rawArgs.order_id;
      // Perhatikan: parameter UID disuntikkan dari sesi terverifikasi!
      const tx = this.mockTransactions.get(orderId) || {
        order_id: orderId,
        status: 'not_found',
      };

      const result = {
        ...tx,
        player_uid: verifiedUid, // Wajib menggunakan verified UID
      };

      const logEntry: ToolCallResult = {
        tool_name: toolName,
        player_uid_used: verifiedUid,
        result,
        success: true,
      };
      this.executionLog.push(logEntry);
      return logEntry;
    }

    if (toolName === 'get_account_status') {
      const result = {
        player_uid: verifiedUid,
        status: 'active',
        level: context.verifiedPlayer.level || 1,
        vip_tier: context.verifiedPlayer.vip_tier || 0,
        server: context.verifiedPlayer.server || 'SEA-1',
      };

      const logEntry: ToolCallResult = {
        tool_name: toolName,
        player_uid_used: verifiedUid,
        result,
        success: true,
      };
      this.executionLog.push(logEntry);
      return logEntry;
    }

    if (toolName === 'get_event_claim') {
      const eventId = rawArgs.event_id;
      const result = {
        player_uid: verifiedUid,
        event_id: eventId,
        claimed: true,
      };

      const logEntry: ToolCallResult = {
        tool_name: toolName,
        player_uid_used: verifiedUid,
        result,
        success: true,
      };
      this.executionLog.push(logEntry);
      return logEntry;
    }

    if (toolName === 'get_server_status') {
      const serverName = rawArgs.server || context.verifiedPlayer.server || 'SEA-1';
      const result = {
        server: serverName,
        status: 'online',
        maintenance: false,
      };

      const logEntry: ToolCallResult = {
        tool_name: toolName,
        player_uid_used: verifiedUid,
        result,
        success: true,
      };
      this.executionLog.push(logEntry);
      return logEntry;
    }

    // 3. Tool tulis yang sah
    if (toolName === 'create_ticket') {
      const ticketId = `TCK-${Date.now().toString().slice(-6)}`;
      const result = {
        ticket_id: ticketId,
        category: rawArgs.category || 'general',
        subcategory: rawArgs.subcategory || 'inquiry',
        summary: rawArgs.summary || '',
        player_uid: verifiedUid,
        status: 'open',
      };

      const logEntry: ToolCallResult = {
        tool_name: toolName,
        player_uid_used: verifiedUid,
        result,
        success: true,
      };
      this.executionLog.push(logEntry);
      return logEntry;
    }

    if (toolName === 'request_handoff') {
      const result = {
        requested: true,
        reason: rawArgs.reason || 'bot_request',
        bot_summary: rawArgs.bot_summary || 'Handoff requested by bot',
      };

      const logEntry: ToolCallResult = {
        tool_name: toolName,
        player_uid_used: verifiedUid,
        result,
        success: true,
      };
      this.executionLog.push(logEntry);
      return logEntry;
    }

    throw new Error(`Tool '${toolName}' tidak dikenal atau tidak terdaftar.`);
  }
}
