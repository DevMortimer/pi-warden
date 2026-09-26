/** One line for the status bar, clipped to the bar width. */
export function headline(rows) {
  return summary(rows).slice(0, 60);
}

/** The number of rows in the report. */
export function rowCount(rows) {
  return rows.length;
}

/** Joins the rows into one line. */
export function summary(rows) {
  return rows.map(row => `${row.name}: ${row.count}`).join(", ");
}
