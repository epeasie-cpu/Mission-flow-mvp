/** Split a SQL script on semicolons, keeping dollar-quoted function bodies intact. */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let dollar: string | null = null;

  while (i < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length;
        dollar = null;
        continue;
      }
      current += sql[i++];
      continue;
    }

    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      current += chunk;
      i += chunk.length;
      continue;
    }

    if (sql[i] === "'") {
      current += sql[i++];
      while (i < sql.length) {
        if (sql.startsWith("''", i)) {
          current += "''";
          i += 2;
          continue;
        }
        current += sql[i];
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (sql[i] === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        dollar = match[0];
        current += dollar;
        i += dollar.length;
        continue;
      }
    }

    if (sql[i] === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      i++;
      continue;
    }

    current += sql[i++];
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
