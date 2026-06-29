export interface CoversTeamStat {
  season: number;
  snapshotDate: string;
  teamCode: string;
  teamName: string;
  wins: number;
  losses: number;
  moneyValue: number;
  homeWins: number;
  homeLosses: number;
  homeMoneyValue: number;
  awayWins: number;
  awayLosses: number;
  awayMoneyValue: number;
  runLineWins: number;
  runLineLosses: number;
  runLineMoney: number;
  overUnderWins: number;
  overUnderLosses: number;
  hittingAvg: number;
  hittingOps: number;
  pitchingEra: number;
  bullpenEra: number;
}

export interface CoversTeamStatsResponse {
  success: boolean;
  snapshotDate: string | null;
  count: number;
  data: CoversTeamStat[];
}
