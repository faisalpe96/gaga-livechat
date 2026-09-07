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
  const [inputText, setInputText] = useState('');
  const [isOpen, setIsOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const t = getTranslations(locale);

  useEffect(() => {
    client.onMessage = (_msg) => {
      setMessages(client.getMessages());
      scrollToBottom();
    };

    client.onConnectionChange = (state) => {
      setConnState(state);
    };

    client.onSessionStarted = (_convId, newLocale) => {
      setLocale(newLocale as SupportedLocale);
      setMessages(client.getMessages());
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
          width: 380px;
          height: 580px;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
          overflow: hidden;
          border: 1px solid #e2e8f0;
          box-sizing: border-box;
        }
        .gaga-header {
          background: linear-gradient(135deg, #4f46e5 0%, #3730a3 100%);
          color: white;
          padding: 14px 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .gaga-header-info {
          display: flex;
          flex-direction: column;
        }
        .gaga-header-title {
          font-weight: 700;
          font-size: 16px;
        }
        .gaga-header-status {
          font-size: 12px;
          opacity: 0.9;
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 2px;
        }
        .gaga-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        .gaga-status-dot.connected { background-color: #10b981; }
        .gaga-status-dot.connecting { background-color: #f59e0b; }
        .gaga-status-dot.disconnected { background-color: #ef4444; }
        .gaga-lang-select {
          background: rgba(255, 255, 255, 0.2);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.4);
          border-radius: 8px;
          padding: 4px 8px;
          font-size: 12px;
          outline: none;
          cursor: pointer;
        }
        .gaga-lang-select option {
          background: #3730a3;
          color: white;
        }
        .gaga-messages {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: #f8fafc;
        }
        .gaga-msg {
          max-width: 80%;
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
          font-size: 11px;
          color: #64748b;
          margin-bottom: 2px;
        }
        .gaga-msg-bubble {
          padding: 10px 14px;
          border-radius: 12px;
          font-size: 14px;
          line-height: 1.4;
          word-break: break-word;
        }
        .gaga-msg.player .gaga-msg-bubble {
          background: #4f46e5;
          color: white;
          border-bottom-right-radius: 2px;
        }
        .gaga-msg.bot .gaga-msg-bubble, .gaga-msg.agent .gaga-msg-bubble {
          background: #ffffff;
          color: #1e293b;
          border: 1px solid #e2e8f0;
          border-bottom-left-radius: 2px;
        }
        .gaga-msg.system .gaga-msg-bubble {
          background: #f1f5f9;
          color: #475569;
          font-style: italic;
          font-size: 13px;
        }
        .gaga-badge-translated {
          display: inline-block;
          margin-top: 4px;
          font-size: 10px;
          background: #fef3c7;
          color: #b45309;
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid #fde68a;
          font-weight: 500;
        }
        .gaga-input-area {
          padding: 12px 14px;
          background: #ffffff;
          border-top: 1px solid #e2e8f0;
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .gaga-input {
          flex: 1;
          border: 1px solid #cbd5e1;
          border-radius: 20px;
          padding: 8px 14px;
          font-size: 14px;
          outline: none;
          transition: border-color 0.2s;
        }
        .gaga-input:focus {
          border-color: #4f46e5;
        }
        .gaga-btn-send {
          background: #4f46e5;
          color: white;
          border: none;
          border-radius: 20px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }
        .gaga-btn-send:hover {
          background: #4338ca;
        }
        .gaga-btn-send:disabled {
          background: #94a3b8;
          cursor: not-allowed;
        }
      `}</style>

      {/* Header */}
      <div class="gaga-header">
        <div class="gaga-header-info">
          <span class="gaga-header-title">{t.title}</span>
          <span class="gaga-header-status">
            <span class={`gaga-status-dot ${connState}`} />
            {getStatusText()}
          </span>
        </div>
        <LanguageSelector currentLocale={locale} onChangeLocale={handleLocaleChange} />
      </div>

      {/* Message List */}
      <div class="gaga-messages">
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', marginTop: '40px' }}>
            {t.welcomeMessage || t.title}
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} class={`gaga-msg ${msg.sender_type}`}>
            <span class="gaga-msg-sender">
              {msg.sender_name || (msg.sender_type === 'player' ? 'You' : 'Gaga Assist')}
            </span>
            <div class="gaga-msg-bubble">{msg.text}</div>
            {msg.translated && (
              <span class="gaga-badge-translated">🌐 {t.translatedBadge}</span>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <div class="gaga-input-area">
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
          disabled={!inputText.trim()}
        >
          {t.sendButton}
        </button>
      </div>
    </div>
  );
}
