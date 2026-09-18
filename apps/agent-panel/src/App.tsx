import React, { useState, useEffect, useCallback } from 'react';
import { Agent, QueueItem, Message } from './types.js';
import {
  fetchCurrentUser,
  logout,
  fetchQueue,
  claimConversation,
  fetchMessages,
  sendAgentMessage,
  resolveConversation,
  API_BASE,
} from './api/client.js';
import { QueueList } from './components/QueueList.js';
import { ChatRoom } from './components/ChatRoom.js';
import { AGENT_TRANSLATIONS } from './i18n/translations.js';

export const App: React.FC = () => {
  const t = AGENT_TRANSLATIONS;
  const [currentAgent, setCurrentAgent] = useState<Agent | null>(null);
  const [selectedLocale, setSelectedLocale] = useState<string>('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<QueueItem | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingQueue, setIsLoadingQueue] = useState<boolean>(false);
  const [isClaiming, setIsClaiming] = useState<boolean>(false);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);

  // Load current authenticated agent on startup
  useEffect(() => {
    setIsAuthChecking(true);
    fetchCurrentUser()
      .then((user) => {
        if (!user) {
          const redirectUrl = encodeURIComponent(window.location.href);
          window.location.href = `${API_BASE}/login?redirect=${redirectUrl}`;
          return;
        }
        setCurrentAgent(user);
        setIsAuthChecking(false);
      })
      .catch((err) => {
        console.error('Auth verification error:', err);
        window.location.href = `${API_BASE}/login`;
      });
  }, []);

  // Fetch queue
  const loadQueue = useCallback(async () => {
    if (!currentAgent) return;
    try {
      setIsLoadingQueue(true);
      const items = await fetchQueue({
        agentId: currentAgent.id,
        locale: selectedLocale || undefined,
      });
      setQueue(items);

      if (selectedConversation) {
        const updated = items.find((q) => q.id === selectedConversation.id);
        if (updated) {
          setSelectedConversation(updated);
        }
      }
    } catch (err) {
      console.error('Failed to load queue:', err);
    } finally {
      setIsLoadingQueue(false);
    }
  }, [currentAgent, selectedLocale, selectedConversation]);

  useEffect(() => {
    if (!currentAgent) return;
    loadQueue();
    const interval = setInterval(loadQueue, 4000);
    return () => clearInterval(interval);
  }, [loadQueue, currentAgent]);

  // Load messages when conversation selected
  useEffect(() => {
    if (!selectedConversation) {
      setMessages([]);
      return;
    }
    fetchMessages(selectedConversation.id)
      .then(setMessages)
      .catch(console.error);

    const msgInterval = setInterval(() => {
      fetchMessages(selectedConversation.id).then(setMessages).catch(console.error);
    }, 3000);

    return () => clearInterval(msgInterval);
  }, [selectedConversation?.id]);

  const handleClaim = async () => {
    if (!selectedConversation || !currentAgent) return;
    try {
      setIsClaiming(true);
      const updated = await claimConversation(selectedConversation.id, currentAgent.id);
      setSelectedConversation(updated);
      await loadQueue();
    } catch (err: any) {
      alert(`${t.chat.claimFailed} ${err.message || t.common.error}`);
    } finally {
      setIsClaiming(false);
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!selectedConversation || !currentAgent) return;
    await sendAgentMessage(selectedConversation.id, currentAgent.id, text);
    const updatedMsgs = await fetchMessages(selectedConversation.id);
    setMessages(updatedMsgs);
  };

  const handleResolve = async () => {
    if (!selectedConversation) return;
    if (!confirm(t.chat.resolveConfirm)) return;
    try {
      await resolveConversation(selectedConversation.id);
      alert(t.chat.resolveSuccess);
      setSelectedConversation(null);
      await loadQueue();
    } catch (err: any) {
      alert(`${t.chat.resolveFailed} ${err.message || t.common.error}`);
    }
  };

  const handleLogout = async () => {
    if (!confirm(t.panel.logoutConfirm)) return;
    await logout();
    window.location.href = `${API_BASE}/login`;
  };

  if (isAuthChecking) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-200">
        <div className="flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-[#25B884]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-sm font-medium">{t.panel.authChecking}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Bar */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-3.5">
          <img src="/logo-mark.png" alt="Gaga Games" className="h-7 w-auto object-contain shrink-0" style={{ height: '28px' }} />
          <div>
            <h1 className="font-bold text-base leading-none text-white tracking-wide">
              {t.panel.title}
            </h1>
            <p className="text-xs text-slate-400 mt-1">{t.panel.subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Sesi Identitas Login (Dropdown pemilih agent dihapus, identitas dari sesi login) */}
          <div className="flex items-center gap-2 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-xs text-slate-300 font-semibold">{currentAgent?.name}</span>
            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-[#25B884]/20 text-[#25B884] border border-[#25B884]/30">
              {currentAgent?.role || 'AGENT'}
            </span>
            <span className="text-[11px] text-slate-400">
              [{currentAgent?.locales?.join(', ')}]
            </span>
          </div>

          {currentAgent?.role === 'admin' && (
            <a
              href={`${API_BASE}/studio`}
              target="_blank"
              rel="noreferrer"
              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 font-medium"
            >
              <span>⚙️ {t.panel.studioButton}</span>
            </a>
          )}

          <a
            href={`${API_BASE}/demo`}
            target="_blank"
            rel="noreferrer"
            className="text-xs bg-[#167956] hover:bg-[#126346] text-white font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
          >
            {t.panel.demoButton} &rarr;
          </a>

          <button
            onClick={handleLogout}
            className="text-xs bg-slate-800 hover:bg-rose-950/60 hover:text-rose-300 hover:border-rose-800 text-slate-300 border border-slate-700 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 font-medium cursor-pointer"
            title={t.panel.logoutButton}
          >
            <span>🚪 {t.panel.logoutButton}</span>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-96 flex-shrink-0">
          <QueueList
            queue={queue}
            selectedId={selectedConversation?.id}
            onSelect={setSelectedConversation}
            currentAgent={currentAgent}
            selectedLocale={selectedLocale}
            onLocaleChange={setSelectedLocale}
            onRefresh={loadQueue}
            isLoading={isLoadingQueue}
          />
        </div>

        <ChatRoom
          conversation={selectedConversation}
          messages={messages}
          currentAgent={currentAgent}
          onClaim={handleClaim}
          onSendMessage={handleSendMessage}
          onResolve={handleResolve}
          isClaiming={isClaiming}
        />
      </div>
    </div>
  );
};

export default App;
