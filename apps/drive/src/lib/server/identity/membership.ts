interface Statement {
  bind(id: string): Statement;
  first<T>(): Promise<T | null>;
}
interface Database { prepare(sql: string): Statement }

export interface ActivePrincipal {
  id: string;
  role: 'owner' | 'member';
}

// A caller-supplied ID is not authentication; callers must establish identity separately.
export async function findActivePrincipal(db: Database, id: string): Promise<ActivePrincipal | null> {
  return db.prepare(`SELECT id, role FROM drive_principals WHERE id = ? AND status = 'active'`)
    .bind(id).first<ActivePrincipal>();
}
