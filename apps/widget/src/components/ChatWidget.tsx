import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { ChatMessage, SupportedLocale } from '../types.js';
import { getTranslations } from '../i18n/translations.js';
import { LanguageSelector } from './LanguageSelector.js';
import { ChatWebSocketClient, ConnectionState } from '../connection/websocket-client.js';

interface ChatWidgetProps {
  client: ChatWebSocketClient;
}

export function ChatWidget({ client }: ChatWidgetProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(client.getMessages());
  const [locale, setLocale] = useState<SupportedLocale>(client.getLocale());
  const [connState, setConnState] = useState<ConnectionState>(client.getState());
  const [selectedCategory, setSelectedCategory] = useState<string | null>(client.getCategory?.() || null);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [highlightAttach, setHighlightAttach] = useState(false);
  const [needsEvidence, setNeedsEvidence] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [botPersona, setBotPersona] = useState<string>(client.getBotPersona() || 'mira');
  const [botName, setBotName] = useState<string>(client.getBotName() || 'Mira');
  const [botAvatar, setBotAvatar] = useState<string>(client.getBotAvatar() || '/assets/agent-mira.png');
  const [activeAgentName, setActiveAgentName] = useState<string | null>(null);
  const [activeAgentAvatar, setActiveAgentAvatar] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const t = getTranslations(locale);

  useEffect(() => {
    client.onMessage = (msg) => {
      setIsTyping(false);
      if (msg.sender_type === 'bot') {
        if (msg.sender_name) setBotName(msg.sender_name);
        if (msg.avatar_url) setBotAvatar(msg.avatar_url);
        if (msg.bot_persona) setBotPersona(msg.bot_persona);

        // Syarat 1: Jika bot meminta bukti/evidence, sorot tombol lampiran & tampilkan hint inline
        const isEvidence =
          Boolean(msg.meta?.needs_evidence) ||
          msg.meta?.evidence_type === 'attachment' ||
          /lampirkan|screenshot|bukti|struk|order id|tangkapan layar|receipt|proof/i.test(msg.text);

        if (isEvidence) {
          setNeedsEvidence(true);
          setHighlightAttach(true);
          setTimeout(() => setHighlightAttach(false), 6000);
        }
      }
      if (msg.sender_type === 'player') {
        setNeedsEvidence(false);
      }
      if (msg.sender_type === 'agent' && msg.sender_name) {
        setActiveAgentName(msg.sender_name);
      }
      setMessages(client.getMessages());
      scrollToBottom();
    };

    client.onTyping = (data) => {
      setIsTyping(data.is_typing);
      if (data.sender_name) {
        if (data.sender_type === 'agent') {
          setActiveAgentName(data.sender_name);
        } else {
          setBotName(data.sender_name);
        }
      }
      if (data.avatar_url) {
        if (data.sender_type === 'agent') {
          setActiveAgentAvatar(data.avatar_url);
        } else {
          setBotAvatar(data.avatar_url);
        }
      }
      scrollToBottom();
    };

    client.onConnectionChange = (state) => {
      setConnState(state);
    };

    client.onSessionStarted = (_convId, newLocale, _market, sessionData) => {
      setLocale(newLocale as SupportedLocale);
      if (sessionData?.bot_persona) setBotPersona(sessionData.bot_persona);
      if (sessionData?.bot_name) setBotName(sessionData.bot_name);
      if (sessionData?.bot_avatar) setBotAvatar(sessionData.bot_avatar);
      if (sessionData?.category) setSelectedCategory(sessionData.category);
      setMessages(client.getMessages());
    };

    client.onCategoryChange = (category) => {
      setSelectedCategory(category);
    };

    client.onStatusChange = (newStatus, _reason, data) => {
      if (newStatus === 'agent_active') {
        const name = data?.agent_name || 'Support Agent';
        setActiveAgentName(name);
        setActiveAgentAvatar('/assets/agent-avatar.png');
      } else if (newStatus === 'resolved') {
        // Sesi ditutup: kembalikan header ke bot; pesan berikutnya membuka sesi baru
        setActiveAgentName(null);
        setActiveAgentAvatar(null);
      }
    };

    client.onHistoryLoaded = (loadedMessages) => {
      setMessages(loadedMessages);
      scrollToBottom();
    };

    client.connect();

    return () => {
      client.disconnect();
    };
  }, [client]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    if (menuOpen) {
      document.addEventListener('mousedown', handleOutside);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  const handleRefresh = () => {
    client.disconnect();
    client.connect();
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  };

  const handleSend = () => {
    if (!inputText.trim()) return;
    client.sendMessage(inputText);
    setInputText('');
  };

  const handleTriggerAttach = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Reset input agar file sama bisa dipilih lagi jika perlu
    input.value = '';

    if (file.size > 5 * 1024 * 1024) {
      alert(locale === 'id-ID' ? 'Ukuran file melebihi batas 5MB' : 'File size exceeds 5MB limit');
      return;
    }

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const b64 = reader.result as string;
          const uploadRes = await fetch('/v1/attachments/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file_base64: b64,
              filename: file.name,
              conversation_id: client.getConversationId?.() || undefined,
            }),
          });

          if (!uploadRes.ok) {
            const errData = await uploadRes.json().catch(() => ({}));
            alert(errData.error || 'Upload gagal');
            setUploading(false);
            return;
          }

          const data = await uploadRes.json();
          const attachment = data.attachment || data.attachments?.[0];
          if (attachment) {
            const msgText = inputText.trim() || `[Attachment: ${attachment.safe_filename}]`;
            client.sendMessage(msgText, {
              attachment_url: attachment.signed_url,
              meta: {
                attachment_url: attachment.signed_url,
                filename: attachment.safe_filename,
                file_size: attachment.file_size,
                mime_type: attachment.mime_type,
              },
            });
            setInputText('');
            setNeedsEvidence(false);
            setHighlightAttach(false);
          }
        } catch (err: any) {
          alert('Gagal mengunggah file: ' + err.message);
        } finally {
          setUploading(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      console.error('File upload error:', err);
      setUploading(false);
    }
  };

  const handleQuickChip = (text: string) => {
    client.sendMessage(text);
  };

  const handleCategorySelect = (categoryKey: string) => {
    setSelectedCategory(categoryKey);
    client.setCategory(categoryKey);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleLocaleChange = (newLocale: SupportedLocale) => {
    setLocale(newLocale);
    client.setLocale(newLocale);
  };

  const getStatusText = () => {
    if (connState === 'connected') return t.statusOnline;
    if (connState === 'connecting') return t.statusConnecting;
    return t.statusOffline;
  };

  return (
    <div class="gaga-widget-container">
      <style>{`
        .gaga-widget-container {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          width: 100%;
          max-width: 400px;
          min-width: 300px;
          height: 620px;
          display: flex;
          flex-direction: column;
          background: #0c1424;
          border-radius: 20px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
          overflow: hidden;
          box-sizing: border-box;
          color: #f8fafc;
        }
        .gaga-header {
          background: linear-gradient(135deg, #10b981 0%, #065f46 100%);
          color: white;
          padding: 10px 14px;
          min-height: 60px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: space-between;
          box-shadow: 0 4px 15px rgba(6, 95, 70, 0.3);
          gap: 10px;
          position: relative;
          z-index: 50;
        }
        .gaga-header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1;
        }
        .gaga-avatar-circle {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.15);
          border: 1.5px solid rgba(255, 255, 255, 0.35);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          flex-shrink: 0;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
        }
        .gaga-avatar-img {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          object-fit: cover;
        }
        .gaga-avatar-dot {
          position: absolute;
          bottom: -1px;
          right: -1px;
          width: 9px;
          height: 9px;
          border-radius: 50%;
          border: 1.5px solid #065f46;
        }
        .gaga-avatar-dot.connected { background-color: #10b981; box-shadow: 0 0 6px #10b981; }
        .gaga-avatar-dot.connecting { background-color: #f59e0b; }
        .gaga-avatar-dot.disconnected { background-color: #ef4444; }

        .gaga-header-meta {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1;
          justify-content: center;
        }
        .gaga-persona-line {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .gaga-persona-name {
          font-weight: 800;
          font-size: 14px;
          letter-spacing: 0.01em;
          color: #ffffff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
          flex-shrink: 1;
        }
        .gaga-persona-badge {
          font-size: 9px;
          font-weight: 700;
          background: rgba(255, 255, 255, 0.2);
          padding: 1px 5px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }
        .gaga-status-line {
          font-size: 11px;
          opacity: 0.88;
          display: flex;
          align-items: center;
          gap: 5px;
          margin-top: 1px;
          min-width: 0;
        }
        .gaga-mini-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .gaga-mini-dot.connected { background-color: #10b981; }
        .gaga-mini-dot.connecting { background-color: #f59e0b; }
        .gaga-mini-dot.disconnected { background-color: #ef4444; }
        .gaga-status-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }

        .gaga-header-right {
          position: relative;
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }
        .gaga-icon-btn {
          background: rgba(255, 255, 255, 0.15);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.25);
          width: 32px;
          height: 32px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          flex-shrink: 0;
          padding: 0;
        }
        .gaga-icon-btn:hover {
          background: rgba(255, 255, 255, 0.28);
          border-color: rgba(255, 255, 255, 0.4);
        }
        .gaga-dropdown-menu {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          background: #0f172a;
          border: 1px solid #1e293b;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 10px;
          min-width: 190px;
          z-index: 100;
          display: flex;
          flex-direction: column;
          gap: 8px;
          animation: gagaMenuFade 0.15s ease-out;
        }
        @keyframes gagaMenuFade {
          from { opacity: 0; transform: translateY(-4px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .gaga-menu-section {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .gaga-menu-label {
          font-size: 10.5px;
          font-weight: 700;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .gaga-lang-selector {
          width: 100%;
        }
        .gaga-lang-select {
          background: #1e293b;
          color: #f8fafc;
          border: 1px solid #334155;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
          font-weight: 500;
          outline: none;
          cursor: pointer;
          width: 100%;
          box-sizing: border-box;
        }
        .gaga-lang-select:focus {
          border-color: #10b981;
        }
        .gaga-menu-hr {
          height: 1px;
          background: rgba(255, 255, 255, 0.08);
          margin: 2px 0;
        }
        .gaga-menu-btn {
          background: transparent;
          border: none;
          color: #cbd5e1;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
          width: 100%;
          box-sizing: border-box;
          transition: background 0.15s;
        }
        .gaga-menu-btn:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
        }
        .gaga-menu-icon {
          font-size: 13px;
        }
        .gaga-messages {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: #080e1a;
        }
        .gaga-msg {
          max-width: 84%;
          display: flex;
          flex-direction: column;
        }
        .gaga-msg.player {
          align-self: flex-end;
        }
        .gaga-msg.bot, .gaga-msg.agent, .gaga-msg.system {
          align-self: flex-start;
        }
        .gaga-msg-sender {
          font-size: 10px;
          color: #94a3b8;
          margin-bottom: 2px;
        }
        .gaga-msg-bubble {
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 13.5px;
          line-height: 1.45;
          word-break: break-word;
        }
        .gaga-msg.player .gaga-msg-bubble {
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          border-bottom-right-radius: 3px;
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25);
        }
        .gaga-msg.bot .gaga-msg-bubble, .gaga-msg.agent .gaga-msg-bubble {
          background: #132238;
          color: #f1f5f9;
          border: 1px solid #1f3556;
          border-bottom-left-radius: 3px;
        }
        .gaga-msg.system .gaga-msg-bubble {
          background: #1e293b;
          color: #94a3b8;
          font-style: italic;
          font-size: 12px;
        }
        .gaga-badge-translated {
          display: inline-block;
          margin-top: 4px;
          font-size: 10px;
          background: rgba(245, 158, 11, 0.15);
          color: #fbbf24;
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid rgba(245, 158, 11, 0.3);
          font-weight: 500;
        }
        .gaga-typing-bar {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 6px 16px;
          background: #080e1a;
          font-size: 11px;
          color: #94a3b8;
        }
        .gaga-typing-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #10b981;
          animation: gagaBounce 1.4s infinite ease-in-out both;
        }
        .gaga-typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .gaga-typing-dot:nth-child(2) { animation-delay: -0.16s; }
        @keyframes gagaBounce {
          0%, 80%, 100% { transform: scale(0); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        .gaga-chips-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px 12px;
          background: #09101d;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .gaga-chips-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .gaga-chips-title {
          font-size: 10.5px;
          font-weight: 700;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .gaga-chip-livechat {
          background: rgba(245, 158, 11, 0.15);
          color: #fbbf24;
          border: 1px solid rgba(245, 158, 11, 0.4);
          padding: 3px 9px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          transition: all 0.2s;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .gaga-chip-livechat:hover {
          background: rgba(245, 158, 11, 0.28);
          border-color: #f59e0b;
          color: #fef08a;
          transform: translateY(-1px);
        }
        .gaga-category-chips-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }
        .gaga-chip-category {
          background: rgba(22, 36, 58, 0.85);
          color: #cbd5e1;
          border: 1px solid #1e3556;
          padding: 4.5px 10px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
          flex-shrink: 0;
          text-overflow: clip;
          overflow: visible;
        }
        .gaga-chip-category:hover {
          background: rgba(16, 185, 129, 0.18);
          border-color: #10b981;
          color: #34d399;
        }
        .gaga-chip-category.active {
          background: rgba(16, 185, 129, 0.25);
          border-color: #10b981;
          color: #6ee7b7;
          box-shadow: 0 0 8px rgba(16, 185, 129, 0.35);
        }
        .gaga-evidence-hint {
          background: rgba(16, 185, 129, 0.12);
          border-top: 1px solid rgba(16, 185, 129, 0.3);
          padding: 6px 14px;
          font-size: 11.5px;
          color: #6ee7b7;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
        }
        .gaga-btn-attach {
          background: #1e293b;
          color: #94a3b8;
          border: 1px solid #334155;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
          flex-shrink: 0;
          padding: 0;
        }
        .gaga-btn-attach:hover {
          background: rgba(16, 185, 129, 0.2);
          border-color: #10b981;
          color: #34d399;
          transform: translateY(-1px);
        }
        .gaga-btn-attach.highlight-pulse {
          background: rgba(16, 185, 129, 0.25);
          border-color: #10b981;
          color: #6ee7b7;
          animation: gagaPulseAttach 1.4s infinite ease-in-out;
        }
        @keyframes gagaPulseAttach {
          0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); transform: scale(1); }
          50% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); transform: scale(1.08); border-color: #34d399; color: #fff; }
          100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); transform: scale(1); }
        }
        .gaga-input-area {
          padding: 10px 14px;
          background: #0c1424;
          border-top: 1px solid #1e293b;
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .gaga-input {
          flex: 1;
          background: #142036;
          border: 1px solid #233758;
          border-radius: 9999px;
          padding: 8px 14px;
          font-size: 13.5px;
          color: #fff;
          outline: none;
          transition: border-color 0.2s;
        }
        .gaga-input:focus {
          border-color: #10b981;
        }
        .gaga-btn-send {
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          border: none;
          border-radius: 9999px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.2s;
        }
        .gaga-btn-send:hover {
          transform: scale(1.03);
        }
        .gaga-btn-send:disabled {
          background: #334155;
          color: #64748b;
          cursor: not-allowed;
        }
      `}</style>

      {/* Redesigned Header: Left Avatar + Name/Status, Right Compact Menu Button */}
      <div class="gaga-header">
        <div class="gaga-header-left">
          {/* Persona Avatar */}
          <div class="gaga-avatar-circle">
            <img
              src={activeAgentAvatar || botAvatar}
              alt={activeAgentName || botName}
              class="gaga-avatar-img"
              onError={(e: any) => {
                e.target.src = botPersona === 'reza' ? '/assets/agent-reza.png' : '/assets/agent-mira.png';
              }}
            />
            <span class={`gaga-avatar-dot ${connState}`} />
          </div>

          {/* Persona Display Name (Line 1) & Status (Line 2) */}
          <div class="gaga-header-meta">
            <div class="gaga-persona-line">
              <span class="gaga-persona-name" title={activeAgentName || botName}>
                {activeAgentName || botName}
              </span>
              <span class="gaga-persona-badge">
                {activeAgentName ? 'Agent' : 'Live CS'}
              </span>
            </div>
            <div class="gaga-status-line">
              <span class={`gaga-mini-dot ${connState}`} />
              <span class="gaga-status-text">{getStatusText()}</span>
            </div>
          </div>
        </div>

        {/* Compact Icon Button with Dropdown Popover */}
        <div class="gaga-header-right" ref={menuRef}>
          <button
            class="gaga-icon-btn"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
            title="Pengaturan & Aksi"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="1.5"></circle>
              <circle cx="12" cy="5" r="1.5"></circle>
              <circle cx="12" cy="19" r="1.5"></circle>
            </svg>
          </button>

          {menuOpen && (
            <div class="gaga-dropdown-menu">
              <div class="gaga-menu-section">
                <span class="gaga-menu-label">🌐 {t.selectLanguage || 'Bahasa'}</span>
                <LanguageSelector
                  currentLocale={locale}
                  onChangeLocale={(newLoc) => {
                    handleLocaleChange(newLoc);
                    setMenuOpen(false);
                  }}
                />
              </div>
              <div class="gaga-menu-hr" />
              <button
                class="gaga-menu-btn"
                onClick={() => {
                  handleRefresh();
                  setMenuOpen(false);
                }}
              >
                <span class="gaga-menu-icon">🔄</span>
                <span>{locale === 'id-ID' ? 'Muat Ulang Sesi' : locale === 'th-TH' ? 'รีเฟรชเซสชัน' : locale === 'fil-PH' ? 'I-refresh ang Sesyon' : locale === 'ms-MY' ? 'Muat Semula Sesi' : locale === 'vi-VN' ? 'Làm mới phiên' : 'Refresh Session'}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Message List */}
      <div class="gaga-messages">
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', marginTop: '40px' }}>
            {t.welcomeMessage || t.title}
          </div>
        )}
        {messages.map((msg) => {
          const isPlayer = msg.sender_type === 'player';
          const isBot = msg.sender_type === 'bot';
          const isAgent = msg.sender_type === 'agent';

          let senderDisplayName = msg.sender_name;
          if (isPlayer) {
            senderDisplayName = 'You';
          } else if (isBot) {
            // Aturan Spec 08: Hanya tampilkan nama persona tanpa embel-embel "Bot" atau "Assistant"
            if (!senderDisplayName || senderDisplayName.toLowerCase().includes('bot') || senderDisplayName.toLowerCase().includes('gaga')) {
              senderDisplayName = botName || (botPersona === 'reza' ? 'Reza' : 'Mira');
            }
          } else if (isAgent) {
            senderDisplayName = activeAgentName || msg.sender_name || 'Support Agent';
          } else {
            senderDisplayName = 'System';
          }

          const messageAvatar = isBot
            ? (msg.avatar_url || botAvatar || (msg.bot_persona === 'reza' ? '/assets/agent-reza.png' : '/assets/agent-mira.png'))
            : isAgent
            ? '/assets/agent-avatar.png'
            : null;

          return (
            <div key={msg.id} class={`gaga-msg ${msg.sender_type}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                {messageAvatar && (
                  <img
                    src={messageAvatar}
                    alt={senderDisplayName}
                    style={{ width: '18px', height: '18px', borderRadius: '50%', objectFit: 'cover' }}
                    onError={(e: any) => {
                      e.target.src = msg.bot_persona === 'reza' ? '/assets/agent-reza.png' : '/assets/agent-mira.png';
                    }}
                  />
                )}
                <span class="gaga-msg-sender">{senderDisplayName}</span>
              </div>
              <div class="gaga-msg-bubble">
                <div>{msg.text}</div>
                {msg.meta?.attachment_url && (
                  <div style={{ marginTop: '8px' }}>
                    <img
                      src={msg.meta.attachment_url}
                      alt="Attachment"
                      style={{ maxWidth: '100%', maxHeight: '180px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', display: 'block' }}
                      loading="lazy"
                    />
                  </div>
                )}
              </div>
              {msg.translated && (
                <span class="gaga-badge-translated">🌐 {t.translatedBadge}</span>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing Indicator */}
      {isTyping && (
        <div class="gaga-typing-bar">
          <span class="gaga-typing-dot" />
          <span class="gaga-typing-dot" />
          <span class="gaga-typing-dot" />
          <span style={{ marginLeft: '4px' }}>{activeAgentName || botName} sedang membalas...</span>
        </div>
      )}

      {/* Category Chips and Live Chat Section */}
      <div class="gaga-chips-section">
        <div class="gaga-chips-header">
          <span class="gaga-chips-title">
            {locale === 'id-ID' ? 'Kategori Kendala' :
             locale === 'th-TH' ? 'หมวดหมู่ปัญหา' :
             locale === 'fil-PH' ? 'Kategorya ng Problema' :
             locale === 'ms-MY' ? 'Kategori Isu' :
             locale === 'vi-VN' ? 'Danh mục sự cố' : 'Issue Category'}:
          </span>
          {/* Dedicated Live Chat Handoff Chip */}
          <button
            class="gaga-chip-livechat"
            onClick={() => handleQuickChip('Hubungkan dengan CS Manusia')}
            title={t.liveChatChip}
          >
            🎧 {t.liveChatChip}
          </button>
        </div>
        {/* Issue Category Chips - wraps cleanly to 2 rows or scrollable, no label truncation */}
        <div class="gaga-category-chips-row">
          <button
            class={`gaga-chip-category ${selectedCategory === 'account_login' ? 'active' : ''}`}
            onClick={() => handleCategorySelect('account_login')}
          >
            <span>🔐</span> <span>{t.categoryAccount}</span>
          </button>
          <button
            class={`gaga-chip-category ${selectedCategory === 'payment_topup' ? 'active' : ''}`}
            onClick={() => handleCategorySelect('payment_topup')}
          >
            <span>💳</span> <span>{t.categoryPayment}</span>
          </button>
          <button
            class={`gaga-chip-category ${selectedCategory === 'technical' ? 'active' : ''}`}
            onClick={() => handleCategorySelect('technical')}
          >
            <span>⚙️</span> <span>{t.categoryTechnical}</span>
          </button>
          <button
            class={`gaga-chip-category ${selectedCategory === 'gameplay_item' ? 'active' : ''}`}
            onClick={() => handleCategorySelect('gameplay_item')}
          >
            <span>🎮</span> <span>{t.categoryGameplay}</span>
          </button>
          <button
            class={`gaga-chip-category ${selectedCategory === 'feedback_other' ? 'active' : ''}`}
            onClick={() => handleCategorySelect('feedback_other')}
          >
            <span>💬</span> <span>{t.categoryFeedback}</span>
          </button>
        </div>
      </div>

      {/* Evidence Inline Hint (Syarat 1) */}
      {needsEvidence && (
        <div class="gaga-evidence-hint">
          <span>📎 {t.attachEvidenceHint}</span>
          <button
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '0 4px',
            }}
            onClick={() => setNeedsEvidence(false)}
            title="Tutup petunjuk"
          >
            ×
          </button>
        </div>
      )}

      {/* Input Form */}
      <div class="gaga-input-area">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />

        {/* Attach-file button visible at all times in every conversation state (bot_active, handoff_queued, agent_active) */}
        <button
          class={`gaga-btn-attach ${highlightAttach ? 'highlight-pulse' : ''}`}
          onClick={handleTriggerAttach}
          title={t.attachTooltip}
          disabled={uploading}
          type="button"
        >
          {uploading ? (
            <span class="gaga-mini-dot connecting" />
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
            </svg>
          )}
        </button>

        <input
          type="text"
          class="gaga-input"
          placeholder={t.inputPlaceholder}
          value={inputText}
          onInput={(e) => setInputText((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button
          class="gaga-btn-send"
          onClick={handleSend}
          disabled={!inputText.trim() && !uploading}
        >
          {t.sendButton}
        </button>
      </div>
    </div>
  );
}
