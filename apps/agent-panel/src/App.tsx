import React, { useState, useEffect, useCallback } from 'react';
import { Agent, QueueItem, Message } from './types.js';
import {
  fetchAgents,
  fetchQueue,
  claimConversation,
  fetchMessages,
  sendAgentMessage,
  resolveConversation,
} from './api/client.js';
import { QueueList } from './components/QueueList.js';
import { ChatRoom } from './components/ChatRoom.js';

export const App: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentAgent, setCurrentAgent] = useState<Agent | null>(null);
  const [selectedLocale, setSelectedLocale] = useState<string>('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<QueueItem | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingQueue, setIsLoadingQueue] = useState<boolean>(false);
  const [isClaiming, setIsClaiming] = useState<boolean>(false);

  // Load agents on startup
  useEffect(() => {
    fetchAgents().then((list) => {
      setAgents(list);
      if (list.length > 0) {
        setCurrentAgent(list[0]);
      }
    }).catch(console.error);
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
    loadQueue();
    const interval = setInterval(loadQueue, 4000);
    return () => clearInterval(interval);
  }, [loadQueue]);

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
      alert('Gagal klaim: ' + (err.message || 'Error'));
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
    if (!confirm('Apakah Anda yakin ingin menyelesaikan sesi obrolan ini?')) return;
    try {
      await resolveConversation(selectedConversation.id);
      alert('Percakapan berhasil diselesaikan.');
      setSelectedConversation(null);
      await loadQueue();
    } catch (err: any) {
      alert('Gagal resolve: ' + (err.message || 'Error'));
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Bar */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center font-bold text-white shadow-sm">
            G
          </div>
          <div>
            <h1 className="font-bold text-base leading-none text-white tracking-wide">
              Gaga LiveChat — Agent Panel
            </h1>
            <p className="text-xs text-slate-400 mt-1">TASK-04 Queue & SLA Management</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700">
            <span className="text-xs text-slate-400 font-medium">Agent:</span>
            <select
              value={currentAgent?.id || ''}
              onChange={(e) => {
                const found = agents.find((a) => a.id === e.target.value);
                if (found) {
                  setCurrentAgent(found);
                  setSelectedLocale('');
                }
              }}
              className="bg-slate-900 text-xs text-indigo-300 font-semibold rounded px-2 py-1 border border-slate-700 focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} [{a.locales.join(', ')}]
                </option>
              ))}
            </select>
          </div>

          <a
            href="http://127.0.0.1:3001/demo"
            target="_blank"
            rel="noreferrer"
            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
          >
            Widget Demo &rarr;
          </a>
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
