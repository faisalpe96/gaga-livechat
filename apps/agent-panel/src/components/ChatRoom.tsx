import React, { useState } from 'react';
import { QueueItem, Message, Agent } from '../types.js';
import { AGENT_TRANSLATIONS } from '../i18n/translations.js';

interface ChatRoomProps {
  conversation: QueueItem | null;
  messages: Message[];
  currentAgent: Agent | null;
  onClaim: () => Promise<void>;
  onSendMessage: (text: string) => Promise<void>;
  onResolve: () => Promise<void>;
  isClaiming: boolean;
}

export const ChatRoom: React.FC<ChatRoomProps> = ({
  conversation,
  messages,
  currentAgent,
  onClaim,
  onSendMessage,
  onResolve,
  isClaiming,
}) => {
  const t = AGENT_TRANSLATIONS;
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);

  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-sm">
        <p>{t.chat.emptySelection}</p>
      </div>
    );
  }

  const isAssignedToMe = conversation.assigned_agent_id === currentAgent?.id;
  const isClaimedByOther = conversation.assigned_agent_id && !isAssignedToMe;
  const isResolved = conversation.status === 'resolved';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isSending) return;
    try {
      setIsSending(true);
      await onSendMessage(inputText.trim());
      setInputText('');
    } catch (err: any) {
      alert(`${t.chat.sendFailed} ${err.message || t.common.error}`);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="bg-slate-900/50 border-b border-slate-800 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#167956]/20 border border-[#25B884]/40 flex items-center justify-center text-[#25B884] font-bold text-xs">
            {conversation.player_uid.slice(-2)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Player: {conversation.player_uid}</h3>
              <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                {conversation.locale}
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded font-mono font-medium ${
                  conversation.status === 'agent_active'
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                    : conversation.status === 'handoff_queued'
                    ? 'bg-amber-950 text-amber-300 border border-amber-700'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {conversation.status}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">ID: {conversation.id}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isResolved && !isAssignedToMe && (
            <button
              onClick={onClaim}
              disabled={isClaiming || !!isClaimedByOther}
              className={`text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm ${
                isClaimedByOther
                  ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
              }`}
            >
              {isClaimedByOther ? t.chat.claimedByOther : isClaiming ? t.chat.claiming : t.chat.claimButton}
            </button>
          )}

          {isAssignedToMe && !isResolved && (
            <button
              onClick={onResolve}
              className="bg-rose-600/90 hover:bg-rose-600 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
            >
              {t.chat.resolveButton}
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-3 flex flex-col justify-end">
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">
            {t.chat.noMessages}
          </div>
        ) : (
          messages.map((msg) => {
            const isAgent = msg.sender_type === 'agent';
            const isPlayer = msg.sender_type === 'player';
            const isSystem = msg.sender_type === 'system';

            if (isSystem) {
              return (
                <div key={msg.id} className="flex justify-center my-1">
                  <div className="bg-slate-800/80 text-slate-400 text-xs px-3 py-1 rounded-full border border-slate-700/60 font-mono">
                    {msg.text}
                  </div>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isAgent ? 'items-end' : isPlayer ? 'items-start' : 'items-center'}`}
              >
                <span className="text-[11px] text-slate-500 mb-1 px-1">
                  {msg.sender_type === 'agent' ? msg.sender_name || t.chat.supportAgentRole : t.chat.playerRole}
                </span>
                <div
                  className={`max-w-md px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    isAgent
                      ? 'bg-[#167956] text-white rounded-br-none shadow-sm'
                      : 'bg-slate-800 text-slate-100 rounded-bl-none border border-slate-700/60'
                  }`}
                >
                  {msg.text}
                </div>
                <span className="text-[10px] text-slate-600 mt-1 px-1">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      {!isResolved && !isClaimedByOther && (
        <div className="p-4 bg-slate-900/60 border-t border-slate-800">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={t.chat.inputPlaceholder}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#25B884] placeholder-slate-500"
            />
            <button
              type="submit"
              disabled={isSending || !inputText.trim()}
              className="bg-[#167956] hover:bg-[#126346] disabled:opacity-50 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm cursor-pointer"
            >
              {isSending ? t.chat.sending : t.chat.sendButton}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
