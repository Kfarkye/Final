import React from 'react';
import * as DashComponents from './Dashboard';

// ============================================================================
// Types
// ============================================================================

export type ViewNode = {
  type: string;
  props?: Record<string, any>;
  children?: ViewNode[];
};

// ============================================================================
// Component Registry
// ============================================================================

const ComponentRegistry: Record<string, React.FC<any>> = {
  Dashboard: DashComponents.default, // Using default export for Dashboard
  Nav: DashComponents.Nav,
  ThemeToggle: DashComponents.ThemeToggle,
  SubNav: DashComponents.SubNav,
  FilterBar: DashComponents.FilterBar,
  DateRail: DashComponents.DateRail,
  DateChip: DashComponents.DateChip,
  PillGroup: DashComponents.PillGroup,
  Pill: DashComponents.Pill,
  Timestamp: DashComponents.Timestamp,
  Badge: DashComponents.Badge,
  TeamRow: DashComponents.TeamRow,
  Matchup: DashComponents.Matchup,
  OddsCell: DashComponents.OddsCell,
  EdgeCell: DashComponents.EdgeCell,
  BookColumn: DashComponents.BookColumn,
  EdgeColumn: DashComponents.EdgeColumn,
  OddsGrid: DashComponents.OddsGrid,
  GameRow: DashComponents.GameRow,
  GameDetail: DashComponents.GameDetail,
  PitcherCard: DashComponents.PitcherCard,
  ColumnHeaders: DashComponents.ColumnHeaders,
  BookHeader: DashComponents.BookHeader,
  EdgeHeader: DashComponents.EdgeHeader,
  OddsTable: DashComponents.OddsTable,
  // Basic layout/UI primitives for generic schema rendering
  Box: ({ children, className, style }) => <div className={className} style={style}>{children}</div>,
  Flex: ({ children, className, style, gap, direction }) => (
    <div className={className} style={{ display: 'flex', gap, flexDirection: direction || 'row', ...style }}>
      {children}
    </div>
  ),
  Text: ({ children, className, style }) => <span className={className} style={style}>{children}</span>,
  Image: ({ src, alt, className, style }) => <img src={src} alt={alt} className={className} style={style} />,
  // Placeholders for components listed in the spec but not yet implemented
  Team: () => <div>Team component pending</div>,
  GameMeta: () => <div>GameMeta component pending</div>,
  WeatherBlock: () => <div>WeatherBlock pending</div>,
  SentimentBlock: () => <div>SentimentBlock pending</div>,
  BettingBar: () => <div>BettingBar pending</div>,
  // Player & Team specific components to be implemented
  PlayerHero: (props) => <div className="player-hero-placeholder">Player Hero: {props.name}</div>,
  TeamHero: (props) => <div className="team-hero-placeholder">Team Hero: {props.name}</div>,
  Tabs: ({ items }) => <div className="tabs-placeholder">Tabs: {items?.join(', ')}</div>,
  DataGrid: () => <div className="data-grid-placeholder">Data Grid</div>,
  TrendChart: () => <div className="trend-chart-placeholder">Trend Chart</div>,
  FormGrid: () => <div className="form-grid-placeholder">Form Grid</div>,
  SidebarSection: ({ title }) => <div className="sidebar-section-placeholder">Sidebar Section: {title}</div>,
  ResultsStrip: () => <div className="results-strip-placeholder">Results Strip</div>,
  ScheduleCard: () => <div className="schedule-card-placeholder">Schedule Card</div>,
  GroupCard: ({ title }) => <div className="group-card-placeholder">Group Card: {title}</div>,
  TrendCard: ({ title }) => <div className="trend-card-placeholder">Trend Card: {title}</div>,
};

// ============================================================================
// Recursion engine
// ============================================================================

export function hydrateProps(props: Record<string, any>, dataCtx: any): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && value.startsWith('$data.')) {
      const path = value.split('.').slice(1);
      let resolved = dataCtx;
      for (const p of path) {
        if (resolved) resolved = resolved[p];
      }
      result[key] = resolved;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function renderNode(node: ViewNode, dataCtx?: any): React.ReactNode {
  const hydratedProps = hydrateProps(node.props || {}, dataCtx);
  
  const Component = ComponentRegistry[node.type];
  if (!Component) {
    console.warn(`Component not found in registry: ${node.type}`);
    return null;
  }

  const children = node.children?.map((child, idx) => (
    <React.Fragment key={idx}>{renderNode(child, dataCtx)}</React.Fragment>
  ));

  return <Component {...hydratedProps}>{children?.length ? children : undefined}</Component>;
}