import Link from "next/link";
import { listDirectory, listDutyNames, listOrgUnits, NOTIONAL_WING_SHORT, runtimeDb } from "@/core";
import { requireAppSession } from "../session";
import { Panel } from "../ui";

export const dynamic = "force-dynamic";

export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string; afsc?: string; duty?: string }>;
}) {
  const app = await requireAppSession();
  const params = await searchParams;
  const db = runtimeDb();
  const [units, duties, everyone] = await Promise.all([listOrgUnits(db), listDutyNames(db), listDirectory(db)]);
  const wing = units.find((unit) => unit.shortCode === NOTIONAL_WING_SHORT);
  const unit = params.unit ?? wing?.id ?? "all";
  const afscs = [...new Set(everyone.map((person) => person.afsc).filter((value): value is string => Boolean(value)))].sort();
  const rows = await listDirectory(db, {
    orgId: unit === "all" ? null : unit,
    afsc: params.afsc || null,
    additionalDuty: params.duty || null,
  });
  const canEdit = app.session.actingRole === "system_admin";
  return (
    <main>
      <Panel hud>
        <p className="kicker">Personnel</p>
        <h1>Directory</h1>
        <p className="lede">Fictional people, units, and additional duties. The chain of command is on each profile.</p>
        {canEdit ? (
          <p className="actions">
            <Link className="btn primary" href="/directory/new">
              Add person
            </Link>
          </p>
        ) : null}
      </Panel>
      <form className="filters" method="get">
        <label>
          <span>Unit</span>
          <select name="unit" defaultValue={unit}>
            <option value="all">All units</option>
            {units.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>AFSC</span>
          <select name="afsc" defaultValue={params.afsc ?? ""}>
            <option value="">Any AFSC</option>
            {afscs.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Additional duty</span>
          <select name="duty" defaultValue={params.duty ?? ""}>
            <option value="">Any additional duty</option>
            {duties.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      {rows.length === 0 ? (
        <p className="panel">No people match these filters.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Rank</th>
                <th scope="col">Unit</th>
                <th scope="col">Duty position</th>
                <th scope="col">AFSC</th>
                <th scope="col">Additional duties</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((person) => (
                <tr key={person.id}>
                  <td>
                    <Link href={`/directory/${person.id}`}>{person.displayName}</Link>
                  </td>
                  <td>{person.rank ?? "—"}</td>
                  <td>{person.orgName}</td>
                  <td>{person.billetLabel ?? "—"}</td>
                  <td className="mono">{person.afsc ?? "—"}</td>
                  <td>
                    {person.duties.length === 0 ? (
                      "—"
                    ) : (
                      <span className="duty-row">
                        {person.duties.map((duty) => (
                          <span key={duty} className="duty-chip">
                            {duty}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
