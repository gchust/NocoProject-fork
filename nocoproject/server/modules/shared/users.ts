/**
 * Display names for user ids, read from the authentication plugin's `user` table.
 */
import type { Conn } from './db.js';
import { str, unique } from './db.js';

export interface UserDirectory {
  names(
    conn: Conn,
    ids: readonly (string | null | undefined)[],
  ): Promise<Map<string, string>>;
  exists(conn: Conn, id: string): Promise<boolean>;
}

export function createUserDirectory(): UserDirectory {
  return {
    async names(conn, ids) {
      const wanted = unique(ids);
      const result = new Map<string, string>();
      if (wanted.length === 0) return result;
      const rows = await conn.query
        .selectFrom('user')
        .select(['id', 'name', 'username'])
        .where('id', 'in', wanted)
        .execute();
      for (const row of rows) {
        const id = str(row.id) ?? '';
        result.set(id, str(row.name) || str(row.username) || id);
      }
      return result;
    },
    async exists(conn, id) {
      return conn.query
        .selectFrom('user')
        .select('id')
        .where('id', '=', id)
        .exists();
    },
  };
}
