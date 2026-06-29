import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { BettingAnglesPayload } from '../services/render/betting-angles.adapter';

interface BettingAnglesBoardProps {
  payloadString: string;
}

export const BettingAnglesBoard: React.FC<BettingAnglesBoardProps> = ({ payloadString }) => {
  const payload = useMemo<BettingAnglesPayload | null>(() => {
    try {
      return JSON.parse(payloadString);
    } catch (e) {
      console.error("Failed to parse bettingangles JSON:", e);
      return null;
    }
  }, [payloadString]);

  if (!payload) {
    return (
      <div className="bg-red-900/20 border border-red-500/50 p-4 rounded-lg text-red-200 text-sm font-mono whitespace-pre-wrap">
        Failed to parse BettingAngles JSON payload.
        {'\n\n'}
        {payloadString}
      </div>
    );
  }

  const getEdgeColor = (tier: string) => {
    switch (tier) {
      case 'Very High': return 'text-green-400 bg-green-400/10 border-green-400/20';
      case 'High': return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
      case 'Medium': return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20';
      case 'Low': return 'text-gray-400 bg-gray-400/10 border-gray-800';
      default: return 'text-gray-400 bg-gray-400/10 border-gray-800';
    }
  };

  return (
    <div className="flex flex-col gap-6 my-6 font-sans">
      {/* Analysis Markdown */}
      {payload.analysis_markdown && (
        <div className="prose prose-invert prose-sm max-w-none text-gray-300">
          <ReactMarkdown>{payload.analysis_markdown}</ReactMarkdown>
        </div>
      )}

      {/* Angles List */}
      {payload.angles && payload.angles.length > 0 && (
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-800 pb-2">
            Identified Edges
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {payload.angles.map((angle, idx) => (
              <div key={idx} className="bg-[#111] border border-gray-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
                {angle.image_url && (
                  <div className="h-32 w-full overflow-hidden bg-[#1a1a1a] border-b border-gray-800">
                    <img src={angle.image_url} alt={angle.title} className="w-full h-full object-cover opacity-80 hover:opacity-100 transition-opacity" />
                  </div>
                )}
                <div className="p-4 flex flex-col flex-grow gap-2">
                  <div className="flex justify-between items-start gap-2">
                    <h4 className="font-semibold text-gray-100 text-[15px] leading-snug">
                      {angle.title}
                    </h4>
                    <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-medium border ${getEdgeColor(angle.edge)}`}>
                      {angle.edge} Edge
                    </span>
                  </div>

                  <p className="text-sm text-gray-400 line-clamp-3">
                    {angle.description}
                  </p>

                  <div className="mt-auto pt-3 border-t border-gray-800/50 flex justify-between items-center text-sm">
                    <span className="text-gray-500 font-medium">{angle.recommendation}</span>
                    <span className="font-mono text-[var(--accent)] font-semibold">{angle.odds}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Consensus Data */}
      {payload.consensus && payload.consensus.splits && payload.consensus.splits.length > 0 && (
        <div className="flex flex-col gap-3 mt-2">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-800 pb-2">
            Market Consensus ({payload.consensus.game_name})
          </h3>
          <div className="bg-[#111] border border-gray-800 rounded-lg overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#1a1a1a] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <tr>
                  <th className="p-3 font-medium">Market</th>
                  <th className="p-3 font-medium text-right">Home Tickets</th>
                  <th className="p-3 font-medium text-right">Home Money</th>
                  <th className="p-3 font-medium text-right">Away Tickets</th>
                  <th className="p-3 font-medium text-right">Away Money</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50 text-gray-300">
                {payload.consensus.splits.map((split, i) => (
                  <tr key={i} className="hover:bg-[#161616]">
                    <td className="p-3 font-medium text-gray-200">
                      {split.betType}
                      {split.sharpSignal && (
                         <span className="ml-2 text-rose-400 text-[10px] uppercase px-1.5 py-0.5 bg-rose-950 rounded border border-rose-900/50">
                           {split.sharpSignal}
                         </span>
                      )}
                    </td>
                    <td className="p-3 text-right">{split.homeTickets}%</td>
                    <td className="p-3 text-right text-[var(--accent)] font-medium">{split.homeMoney}%</td>
                    <td className="p-3 text-right">{split.awayTickets}%</td>
                    <td className="p-3 text-right text-[var(--accent)] font-medium">{split.awayMoney}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
