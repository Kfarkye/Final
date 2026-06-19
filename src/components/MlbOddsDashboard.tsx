import React, { useState } from 'react';

type MarketType = 'Spread' | 'Moneyline' | 'Total' | 'All Markets';
type GameStatus = 'BOT 9TH' | 'Final' | 'PPD' | '10:40 PM' | '7:10 PM' | 'TOP 3RD';

interface Odds {
  dk: string;
  fd: string;
  mgm: string;
  czr: string;
  br: string;
}

interface TeamState {
  name: string;
  score?: number;
  pitcher: string;
  odds: Odds;
}

interface GameProps {
  status: GameStatus;
  away: TeamState;
  home: TeamState;
}

const mockGames: GameProps[] = [
  {
    status: 'BOT 9TH',
    away: {
      name: 'NYY',
      score: 4,
      pitcher: 'G. Cole',
      odds: { dk: '-150', fd: '-148', mgm: '-155', czr: '-150', br: '-145' }
    },
    home: {
      name: 'BOS',
      score: 3,
      pitcher: 'C. Sale',
      odds: { dk: '+130', fd: '+128', mgm: '+135', czr: '+130', br: '+125' }
    }
  },
  {
    status: '7:10 PM',
    away: {
      name: 'LAD',
      pitcher: 'Y. Yamamoto',
      odds: { dk: '-180', fd: '-185', mgm: '-180', czr: '-175', br: '-185' }
    },
    home: {
      name: 'SD',
      pitcher: 'Y. Darvish',
      odds: { dk: '+150', fd: '+155', mgm: '+150', czr: '+145', br: '+155' }
    }
  },
  {
    status: 'Final',
    away: {
      name: 'PHI',
      score: 7,
      pitcher: 'Z. Wheeler',
      odds: { dk: '-120', fd: '-122', mgm: '-118', czr: '-120', br: '-125' }
    },
    home: {
      name: 'ATL',
      score: 2,
      pitcher: 'S. Strider',
      odds: { dk: '+100', fd: '+102', mgm: '-102', czr: '+100', br: '+105' }
    }
  }
];

export const MlbOddsDashboard: React.FC = () => {
  const [activeMarket, setActiveMarket] = useState<MarketType>('Moneyline');
  const markets: MarketType[] = ['Spread', 'Moneyline', 'Total', 'All Markets'];

  return (
    <div className="w-full bg-[#0a0a0a] text-gray-200 font-sans border border-gray-800 rounded-lg shadow-xl overflow-hidden text-sm">
      {/* Sub-header */}
      <div className="flex flex-col md:flex-row justify-between items-center bg-[#111] p-3 border-b border-gray-800">
        <div className="flex space-x-1 mb-2 md:mb-0 bg-[#1a1a1a] p-1 rounded-md">
          {markets.map((m) => (
            <button
              key={m}
              onClick={() => setActiveMarket(m)}
              className={`px-3 py-1.5 rounded text-xs font-semibold tracking-wide transition-colors ${
                activeMarket === m
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex space-x-3 items-center">
          <div className="flex items-center space-x-2 text-xs font-medium text-gray-400 bg-[#1a1a1a] px-3 py-1.5 rounded-md cursor-pointer hover:bg-gray-800 transition-colors">
            <span>📅 Today</span>
          </div>
          <div className="flex items-center space-x-2 text-xs font-medium text-gray-400 bg-[#1a1a1a] px-3 py-1.5 rounded-md cursor-pointer hover:bg-gray-800 transition-colors">
            <span>⚙️ Odds Settings</span>
          </div>
        </div>
      </div>

      {/* Main Scoreboard Grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[700px]">
          <thead>
            <tr className="bg-[#0f0f0f] border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
              <th className="py-3 px-4 font-medium w-[250px]">Game / Pitchers</th>
              <th className="py-3 px-2 font-medium text-center">DraftKings</th>
              <th className="py-3 px-2 font-medium text-center">FanDuel</th>
              <th className="py-3 px-2 font-medium text-center">BetMGM</th>
              <th className="py-3 px-2 font-medium text-center">Caesars</th>
              <th className="py-3 px-2 font-medium text-center">BetRivers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {mockGames.map((game, idx) => (
              <React.Fragment key={idx}>
                {/* Away Team Row */}
                <tr className="hover:bg-[#141414] transition-colors group">
                  <td className="py-3 px-4 relative">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <span className={`text-[10px] font-bold tracking-wider w-16 ${
                          game.status.includes('BOT') || game.status.includes('TOP') 
                            ? 'text-red-500 animate-pulse' 
                            : game.status === 'Final' 
                              ? 'text-gray-500' 
                              : 'text-green-500'
                        }`}>
                          {game.status}
                        </span>
                        <div className="flex items-center space-x-2">
                          <span className="font-bold text-white w-8">{game.away.name}</span>
                          {game.away.score !== undefined && (
                            <span className="font-mono text-gray-300 font-bold">{game.away.score}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-500 w-24 truncate text-right">
                        {game.away.pitcher}
                      </div>
                    </div>
                  </td>
                  <OddsCell value={game.away.odds.dk} />
                  <OddsCell value={game.away.odds.fd} />
                  <OddsCell value={game.away.odds.mgm} />
                  <OddsCell value={game.away.odds.czr} />
                  <OddsCell value={game.away.odds.br} />
                </tr>
                {/* Home Team Row */}
                <tr className="hover:bg-[#141414] border-b-2 border-gray-900 transition-colors group">
                  <td className="py-3 px-4 relative">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <span className="w-16"></span> {/* Spacer for status alignment */}
                        <div className="flex items-center space-x-2">
                          <span className="font-bold text-white w-8">{game.home.name}</span>
                          {game.home.score !== undefined && (
                            <span className="font-mono text-gray-300 font-bold">{game.home.score}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-500 w-24 truncate text-right">
                        {game.home.pitcher}
                      </div>
                    </div>
                  </td>
                  <OddsCell value={game.home.odds.dk} />
                  <OddsCell value={game.home.odds.fd} />
                  <OddsCell value={game.home.odds.mgm} />
                  <OddsCell value={game.home.odds.czr} />
                  <OddsCell value={game.home.odds.br} />
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const OddsCell: React.FC<{ value: string }> = ({ value }) => {
  return (
    <td className="py-2 px-1">
      <div className="flex justify-center items-center h-full">
        <button className="w-full max-w-[80px] py-1.5 px-2 bg-[#1a1a1a] hover:bg-blue-600/20 hover:text-blue-400 border border-transparent hover:border-blue-500/30 rounded text-center font-mono font-medium text-gray-300 transition-all cursor-pointer">
          {value}
        </button>
      </div>
    </td>
  );
};
