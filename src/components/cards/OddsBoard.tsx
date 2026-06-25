import React from 'react';
import { RenderSpec } from '../../hub/render-contract.types';

function groupByBook(rows: any[]) {
  const map = new Map<string, any[]>();
  for (const r of rows) {
    if (!map.has(r.book)) map.set(r.book, []);
    map.get(r.book)!.push(r);
  }
  return [...map.entries()].map(([book, prices]) => ({ book, prices }));
}

function formatPrice(price: string | number, line: number | null) {
  const p = typeof price === 'number' ? (price > 0 ? `+${price}` : `${price}`) : price;
  return line != null ? `${line > 0 ? '+' : ''}${line} (${p})` : p;
}

export function OddsBoard({ render }: { render: RenderSpec }) {
  const f = render.fields || {};
  const rows = render.rows || [];
  const sides = [...new Set(rows.map(r => r.side))] as string[];

  return (
    <div className="odds-board">
      <div className="ob-header">
        <div className="ob-market">{f.market}</div>
        {f.event && <div className="ob-event">{f.event}</div>}
        {f.sharpAnchor && (
          <div className="ob-sharp">
            Sharp <span>{f.sharpAnchor}</span>
          </div>
        )}
      </div>

      <table className="ob-table">
        <thead>
          <tr>
            <th>Book</th>
            {sides.map(s => <th key={s} className="num">{s}</th>)}
          </tr>
        </thead>
        <tbody>
          {groupByBook(rows).map(({ book, prices }) => (
            <tr key={book}>
              <td className="ob-book">{book}</td>
              {sides.map(side => {
                const cell = prices.find((p: any) => p.side === side);
                return (
                  <td key={side} className={`num ${cell?._best ? 'ob-best' : ''}`}>
                    {cell ? formatPrice(cell.price, cell.line) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
