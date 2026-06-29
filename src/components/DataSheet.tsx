import React from 'react';
import { Column, TableBlock } from '../schemas/assistant';

function formatCell(value: any, col: Column) {
  if (value === null || value === undefined) return "—";

  switch (col.type) {
    case "percent":
      return `${(Number(value) * 100).toFixed(1)}%`;
    case "currency":
      return Number(value).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
      });
    case "number":
      return Number(value).toLocaleString("en-US");
    default:
      return String(value);
  }
}

function getCellClass(value: any, col: Column) {
  const classes = ["sheet-cell"];

  if (col.align) classes.push(`align-${col.align}`);

  if (col.type === "percent" && typeof value === "number" && col.thresholds) {
    if (col.thresholds.high !== undefined && value >= col.thresholds.high) {
      classes.push("cell-high");
    }

    if (col.thresholds.low !== undefined && value <= col.thresholds.low) {
      classes.push("cell-low");
    }
  }

  if (col.sticky) {
    classes.push("cell-sticky");
  }

  return classes.join(" ");
}

export function DataSheet({ block }: { block: TableBlock }) {
  return (
    <section className="sheet-card">
      {(block.title || block.subtitle) && (
        <header className="sheet-header">
          {block.title && <h3>{block.title}</h3>}
          {block.subtitle && <p>{block.subtitle}</p>}
        </header>
      )}

      <div className="sheet-scroll">
        <table className="sheet-table">
          <thead>
            <tr>
              {block.columns.map((col) => (
                <th
                  key={col.key}
                  className={[
                    "sheet-head-cell",
                    col.align ? `align-${col.align}` : "",
                    col.sticky ? "cell-sticky" : ""
                  ].join(" ")}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.columns.map((col) => {
                  const value = row[col.key];

                  return (
                    <td key={col.key} className={getCellClass(value, col)}>
                      {formatCell(value, col)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {block.sources?.length ? (
        <footer className="sheet-sources">
          Sources:{" "}
          {block.sources.map((source, index) => (
            <span key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.label}
              </a>
              {index < block.sources!.length - 1 ? ", " : ""}
            </span>
          ))}
        </footer>
      ) : null}
    </section>
  );
}
