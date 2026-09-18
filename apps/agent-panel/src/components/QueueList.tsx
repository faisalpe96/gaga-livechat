import React from 'react';
import { QueueItem, Agent } from '../types.js';
import { AGENT_TRANSLATIONS } from '../i18n/translations.js';

interface QueueListProps {
  queue: QueueItem[];
  selectedId?: string;
  onSelect: (item: QueueItem) => void;
  currentAgent: Agent | null;
  selectedLocale: string;
  onLocaleChange: (loc: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
}

export const QueueList: React.FC<QueueListProps> = ({
  queue,
  selectedId,
  onSelect,
  currentAgent,
  selectedLocale,
  onLocaleChange,
  onRefresh,
  isLoading,
}) => {
  const t = AGENT_TRANSLATIONS;

  return (
    <div className="flex flex-col h-full bg-slate-900/60 border-r border-slate-800">
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">{t.queue.title}</h2>
              <span className="bg-[#25B884]/15 text-[#25B884] border border-[#25B884]/30 text-xs px-2 py-0.5 rounded-full font-mono font-medium">
                {queue.length}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">{t.queue.sortBySla}</p>
          </div>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="text-xs text-slate-400 hover:text-white transition-colors"
          >
            {isLoading ? '...' : t.common.refreshQueue}
          </button>
        </div>

        <div>
          <label className="text-[11px] text-slate-400 block mb-1">{t.queue.languageFilter}</label>
          <select
            value={selectedLocale}
            onChange={(e) => onLocaleChange(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded px-2.5 py-1.5 focus:outline-none focus:border-[#25B884]"
          >
            <option value="">{t.queue.allLanguages} ({currentAgent?.locales.join(', ') || 'N/A'})</option>
            {currentAgent?.locales.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {queue.length === 0 ? (
          <div className="text-center py-10 text-slate-500 text-xs">
            {isLoading ? t.queue.loadingQueue : t.queue.emptyQueue}
          </div>
        ) : (
          queue.map((item) => {
            const isSelected = selectedId === item.id;
            let slaText = 'Normal SLA';
            let slaClass = 'bg-slate-800 text-slate-400 border-slate-700';

            if (item.sla_due_at) {
              const diffMs = new Date(item.sla_due_at).getTime() - Date.now();
              const diffMin = Math.round(diffMs / 60000);
              if (diffMin < 0) {
                slaText = `Overdue (${Math.abs(diffMin)}m)`;
                slaClass = 'bg-rose-950 text-rose-300 border-rose-800 font-bold';
              } else if (diffMin <= 5) {
                slaText = `${diffMin}m left`;
                slaClass = 'bg-amber-950 text-amber-300 border-amber-800 font-bold';
              } else {
                slaText = `${diffMin}m left`;
                slaClass = 'bg-slate-800 text-slate-300 border-slate-700';
              }
            }

            return (
              <div
                key={item.id}
                onClick={() => onSelect(item)}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-slate-800 border-[#25B884] shadow-sm ring-1 ring-[#25B884]/50'
                    : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${item.status === 'bot_active' ? 'bg-emerald-400' : 'bg-amber-400'} animate-pulse`}></span>
                    UID: {item.player_uid}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${item.status === 'bot_active' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/50' : 'bg-amber-950/80 text-amber-300 border border-amber-700/50'}`}>
                      {item.status === 'bot_active' ? 'Shadow Mode' : 'Handoff Queue'}
                    </span>
                    <span className="text-[10px] bg-[#167956]/20 text-[#25B884] border border-[#25B884]/40 px-1.5 py-0.5 rounded font-mono">
                      {item.locale}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-slate-300 line-clamp-1 mb-2">
                  {item.bot_summary || item.handoff_reason || 'Player waiting for response'}
                </p>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1.5 border-t border-slate-800/80">
                  <span>Market: {item.market}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${slaClass}`}>{slaText}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
