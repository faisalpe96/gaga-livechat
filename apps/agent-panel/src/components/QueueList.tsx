import React from 'react';
import { QueueItem, Agent } from '../types.js';

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
  return (
    <div className="flex flex-col h-full bg-slate-900/60 border-r border-slate-800">
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Antrean Percakapan</h2>
            <span className="bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 text-xs px-2 py-0.5 rounded-full font-mono font-medium">
              {queue.length}
            </span>
          </div>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="text-xs text-slate-400 hover:text-white transition-colors"
          >
            {isLoading ? '...' : 'Refresh'}
          </button>
        </div>

        <div>
          <label className="text-[11px] text-slate-400 block mb-1">Filter Bahasa:</label>
          <select
            value={selectedLocale}
            onChange={(e) => onLocaleChange(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
          >
            <option value="">Semua Bahasa Agent ({currentAgent?.locales.join(', ') || 'N/A'})</option>
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
            {isLoading ? 'Memuat antrean...' : 'Tidak ada antrean percakapan saat ini.'}
          </div>
        ) : (
          queue.map((item) => {
            const isSelected = selectedId === item.id;
            let slaText = 'SLA Normal';
            let slaClass = 'bg-slate-800 text-slate-400 border-slate-700';

            if (item.sla_due_at) {
              const diffMs = new Date(item.sla_due_at).getTime() - Date.now();
              const diffMin = Math.round(diffMs / 60000);
              if (diffMin < 0) {
                slaText = `Terlewat (${Math.abs(diffMin)}m)`;
                slaClass = 'bg-rose-950 text-rose-300 border-rose-800 font-bold';
              } else if (diffMin <= 5) {
                slaText = `Sisa ${diffMin}m`;
                slaClass = 'bg-amber-950 text-amber-300 border-amber-800 font-bold';
              } else {
                slaText = `Sisa ${diffMin}m`;
                slaClass = 'bg-slate-800 text-slate-300 border-slate-700';
              }
            }

            return (
              <div
                key={item.id}
                onClick={() => onSelect(item)}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-slate-800 border-indigo-500 shadow-sm ring-1 ring-indigo-500/50'
                    : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                    UID: {item.player_uid}
                  </span>
                  <span className="text-[10px] bg-indigo-950 text-indigo-300 border border-indigo-800/40 px-1.5 py-0.5 rounded font-mono">
                    {item.locale}
                  </span>
                </div>
                <p className="text-xs text-slate-300 line-clamp-1 mb-2">
                  {item.bot_summary || item.handoff_reason || 'Pemain menunggu respons'}
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
