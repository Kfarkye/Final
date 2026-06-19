import React, { useState } from 'react';
import './dashboard.css';


  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    fetch('/api/mlb/slate/unified')
      .then(res => res.json())
      .then(resData => {
        // The API returns { date, generatedAt, games, meta }
        // We construct the dataLayer expected by our renderer
        setData({
          meta: {
            ...resData.meta,
            date: resData.date,
            lastUpdated: resData.generatedAt,
            books: ["pinnacle", "draftkings", "fanduel", "betmgm", "caesars", "bet365"] // Placeholder books since API might not return book names directly
          },
          data: {
            games: resData.games
          }
        });
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch unified slate", err);
        setLoading(false);
      });
  }, []);

  if (loading || !data) return <div className="truth-dashboard-loading">Loading live data...</div>;

  // We build a simple fallback view tree matching the dashboard layout, 
  // since the full view tree is not currently provided by the backend.
  const fallbackViewTree = {
    type: "Dashboard",
    props: { className: "truth-dashboard" },
    children: [
      { type: "Nav" },
      { type: "SubNav" },
      {
        type: "div", // Using native element for content wrapper (we can add a div component or just fallback to native if supported, wait, ComponentRegistry doesn't support 'div'. Let's avoid 'div')
        props: { className: "dash-content" }
      }
    ]
  };

  return (
    <div className="truth-dashboard">
      <Nav />
      <SubNav />
      <div className="dash-content">
        <FilterBar meta={data.meta} />
        <OddsTable games={data.data.games} books={data.meta.books} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<{ meta: any; data: any } | null>(null);
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    fetch('/api/mlb/slate/unified')
      .then(res => res.json())
      .then(resData => {
        // The API returns { date, generatedAt, games, meta }
        // We construct the dataLayer expected by our renderer
        setData({
          meta: {
            ...resData.meta,
            date: resData.date,
            lastUpdated: resData.generatedAt,
            books: ["pinnacle", "draftkings", "fanduel", "betmgm", "caesars", "bet365"] // Placeholder books since API might not return book names directly
          },
          data: {
            games: resData.games
          }
        });
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch unified slate", err);
        setLoading(false);
      });
  }, []);

  if (loading || !data) return <div className="truth-dashboard-loading">Loading live data...</div>;

  return (
    <div className="truth-dashboard">
      <Nav />
      <SubNav />
      <div className="dash-content">
        <FilterBar meta={data.meta} />
        <OddsTable games={data.data.games} books={data.meta.books} />
      </div>
    </div>
  );
}

            lastUpdated: resData.generatedAt,
            books: resData.meta.books || []