import Link from "next/link";
import { getPersonProfile, listDirectory, listOrgUnits, runtimeDb } from "@/core";
import { requireAppSession } from "../../session";
import { Panel } from "../../ui";
import { PersonForm } from "../person-form";

export const dynamic = "force-dynamic";

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const app = await requireAppSession();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <Missing />;
  const profile = await getPersonProfile(runtimeDb(), id);
  if (!profile) return <Missing />;
  const canEdit = app.session.actingRole === "system_admin";
  const [units, people] = canEdit ? await Promise.all([listOrgUnits(runtimeDb()), listDirectory(runtimeDb())]) : [[], []];
  const { person } = profile;
  return (
    <main>
      <p className="crumb">
        <Link href="/directory">Directory</Link>
      </p>
      <Panel hud>
        <p className="kicker">{person.rank ?? "Profile"}</p>
        <h1>{person.displayName}</h1>
        <p className="lede">
          {person.billetLabel ?? "Duty position not set"}
          {person.leadershipTitle ? ` · ${person.leadershipTitle}` : ""}
        </p>
        {query.notice === "updated" ? <p className="notice">Saved. The audit log records personnel.updated.</p> : null}
        {query.notice === "created" ? <p className="notice">Added. The audit log records personnel.created.</p> : null}
        {query.error ? <p className="notice">{query.error}</p> : null}
        <p className="meta">{profile.orgPath.map((unit) => unit.name).join(" / ")}</p>
        <dl className="fields">
          <div>
            <dt>Rank</dt>
            <dd>{person.rank ?? "—"}</dd>
          </div>
          <div>
            <dt>AFSC</dt>
            <dd>{person.afsc ?? "—"}</dd>
          </div>
          <div>
            <dt>Primary duty</dt>
            <dd>{person.primaryDuty ?? "—"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{person.email}</dd>
          </div>
          <div>
            <dt>Availability</dt>
            <dd>{person.availability}</dd>
          </div>
          <div>
            <dt>Functions</dt>
            <dd>{person.functions.length ? person.functions.join(", ") : "—"}</dd>
          </div>
        </dl>
        <h2>Additional duties</h2>
        {person.duties.length === 0 ? (
          <p className="meta">None recorded.</p>
        ) : (
          <p className="duty-row">
            {person.duties.map((duty) => (
              <span key={duty} className="duty-chip">
                {duty}
              </span>
            ))}
          </p>
        )}
      </Panel>
      <h2>Chain of command</h2>
      <ol className="chain">
        {profile.chain.map((link) => (
          <li key={link.id} className={link.id === person.id ? "is-self" : undefined}>
            <Link className="who-line" href={`/directory/${link.id}`}>
              {link.rank ? `${link.rank} ` : ""}
              {link.displayName}
            </Link>
            <span className="meta">
              {link.leadershipTitle ?? link.billetLabel ?? "Member"} · {link.orgName}
            </span>
          </li>
        ))}
      </ol>
      {profile.reports.length > 0 ? (
        <>
          <h2>Direct reports</h2>
          <ul className="match-list">
            {profile.reports.map((report) => (
              <li key={report.id}>
                <Link href={`/directory/${report.id}`}>
                  {report.rank ? `${report.rank} ` : ""}
                  {report.displayName}
                </Link>
                <span className="meta"> · {report.billetLabel ?? "Member"}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canEdit ? (
        <Panel>
          <h2>Edit person</h2>
          <PersonForm
            mode="edit"
            orgs={units.map((unit) => ({ id: unit.id, name: unit.name }))}
            people={people.map((item) => ({ id: item.id, displayName: item.displayName, rank: item.rank }))}
            person={{
              id: person.id,
              displayName: person.displayName,
              email: person.email,
              orgId: person.orgId,
              rank: person.rank ?? "",
              billetLabel: person.billetLabel ?? "",
              afsc: person.afsc ?? "",
              primaryDuty: person.primaryDuty ?? "",
              functions: person.functions,
              supervisorUserId: person.supervisorUserId,
              leadershipTitle: person.leadershipTitle,
              duties: person.duties,
              availability: person.availability as "available" | "tdy" | "deployed" | "leave" | "reassigned",
            }}
          />
        </Panel>
      ) : null}
    </main>
  );
}

function Missing() {
  return (
    <main>
      <h1>Not available</h1>
      <p className="lede">That person is not in the directory.</p>
      <p className="crumb">
        <Link href="/directory">Back to the directory</Link>
      </p>
    </main>
  );
}
