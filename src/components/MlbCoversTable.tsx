import React, { useEffect, useState } from 'react';
import type { CoversTeamStat, CoversTeamStatsResponse } from '../types/covers.types';

export const MlbCoversTable: React.FC = () => {
  const [data, setData] = useState<CoversTeamStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/mlb/covers/team-stats')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: CoversTeamStatsResponse) => {
        if (json.success) {
          // Sort by Wins descending, then by money value
          const sorted = (json.data || []).sort((a, b) => b.wins - a.wins || b.moneyValue - a.moneyValue);
          setData(sorted);
        } else {
          throw new Error('API returned success: false');
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-gray-400 p-4 bg-[#0a0a0a] rounded-lg border border-gray-800 animate-pulse text-sm">Loading Covers Team Stats...</div>;
  }

  if (error) {
    return <div className="text-red-500 p-4 border border-red-500/20 bg-[#0a0a0a] rounded-lg text-sm">Failed to load Covers stats: {error}</div>;
  }

  return (
    <div className="w-full bg-[#0a0a0a] text-gray-200 font-sans border border-gray-800 rounded-lg shadow-xl overflow-x-auto text-[13px] my-4">
      <div className="bg-[#111] p-3 border-b border-gray-800 flex justify-between items-center">
        <h3 className="font-semibold text-gray-100 flex items-center space-x-2">
          <span>📊</span>
          <span>Covers MLB Team Stats</span>
        </h3>
        <div className="text-xs font-medium text-gray-500 bg-[#1a1a1a] px-2 py-1 rounded">
          {data.length > 0 ? `Snapshot: ${data[0].snapshotDate}` : 'No Data'}
        </div>
      </div>
      <table className="w-full text-left border-collapse min-w-[700px]">
        <thead>
          <tr className="bg-[#1a1a1a] text-gray-400 text-xs tracking-wider border-b border-gray-800 uppercase">
            <th className="p-2 font-medium">Team</th>
            <th className="p-2 font-medium">W-L</th>
            <th className="p-2 font-medium text-right">Money</th>
            <th className="p-2 font-medium text-right">RL (W-L)</th>
            <th className="p-2 font-medium text-right">RL Money</th>
            <th className="p-2 font-medium text-right">O/U (W-L)</th>
            <th className="p-2 font-medium text-right">Hit AVG</th>
            <th className="p-2 font-medium text-right">Pitch ERA</th>
            <th className="p-2 font-medium text-right">Bull ERA</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {data.map((team, idx) => (
            <tr key={team.teamCode} className="hover:bg-[#151515] transition-colors">
              <td className="p-2 font-semibold text-gray-100 flex items-center">
                <span className="text-gray-600 w-5 inline-block text-[10px]">{idx + 1}</span>
                <span>{team.teamCode}</span>
              </td>
              <td className="p-2 text-gray-300">{team.wins}-{team.losses}</td>
              <td className={`p-2 text-right font-mono ${team.moneyValue > 0 ? 'text-green-400' : team.moneyValue < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {team.moneyValue > 0 ? '+' : ''}{team.moneyValue}
              </td>
              <td className="p-2 text-right text-gray-400">{team.runLineWins}-{team.runLineLosses}</td>
              <td className={`p-2 text-right font-mono ${team.runLineMoney > 0 ? 'text-green-400' : team.runLineMoney < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {team.runLineMoney > 0 ? '+' : ''}{team.runLineMoney}
              </td>
              <td className="p-2 text-right text-gray-400">{team.overUnderWins}-{team.overUnderLosses}</td>
              <td className="p-2 text-right font-mono text-[var(--accent)]">{team.hittingAvg?.toFixed(3) || '-'}</td>
              <td className="p-2 text-right font-mono text-gray-300">{team.pitchingEra?.toFixed(2) || '-'}</td>
              <td className="p-2 text-right font-mono text-gray-300">{team.bullpenEra?.toFixed(2) || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
