"use client";

import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DemoUploadWarning } from "../../../../ui";
import { createRoutedTaskerAction, previewRoutingAction } from "./actions";

type OrgOption = { id: string; name: string; echelon: string };
type PersonOption = { id: string; displayName: string; rank: string | null; orgName: string };
type Match = {
  id: string;
  displayName: string;
  rank: string | null;
  orgName: string;
  afsc: string | null;
  duties: string[];
  billetLabel: string | null;
};

export function CreateTaskerForm({
  orgs,
  people,
  duties,
}: {
  orgs: OrgOption[];
  people: PersonOption[];
  duties: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [afscs, setAfscs] = useState("");
  const [duty, setDuty] = useState("");
  const [additionalDuty, setAdditionalDuty] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const criteria = useMemo(
    () => ({
      orgIds,
      afscs: afscs.split(",").map((item) => item.trim()).filter(Boolean),
      duty,
      additionalDuty,
      userIds,
    }),
    [orgIds, afscs, duty, additionalDuty, userIds],
  );

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      startTransition(async () => {
        const result = await previewRoutingAction(criteria);
        if (cancelled) return;
        setMatches(result.matches);
        setPreviewError(result.error);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [criteria]);

  function toggleOrg(id: string, checked: boolean) {
    setOrgIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await createRoutedTaskerAction(data);
      if (result.error || !result.taskerId) {
        setError(result.error ?? "The tasker was not created.");
        return;
      }
      router.push(`/work/taskers/${result.taskerId}?notice=routed&count=${result.count ?? 1}`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="tasker-create">
      <div className="stack">
        <label>
          <span>Title</span>
          <input name="title" required maxLength={180} />
        </label>
        <label>
          <span>Description</span>
          <textarea name="description" required maxLength={4000} />
        </label>
        <div className="form-row">
          <label>
            <span>Suspense date</span>
            <input name="suspense" type="date" required defaultValue="2027-04-15" />
          </label>
          <label>
            <span>Priority</span>
            <select name="priority" defaultValue="routine">
              <option value="routine">Routine</option>
              <option value="priority">Priority</option>
            </select>
          </label>
          <label>
            <span>Category</span>
            <select name="category" defaultValue="awards_package">
              <option value="awards_package">awards_package</option>
            </select>
          </label>
        </div>
        <label>
          <span>Additional duty</span>
          <input
            name="additionalDuty"
            value={additionalDuty}
            onChange={(event) => setAdditionalDuty(event.target.value)}
            list="duty-names"
            placeholder="Awards Monitor"
          />
          <datalist id="duty-names">
            {duties.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label>
          <span>AFSC</span>
          <input name="afscs" value={afscs} onChange={(event) => setAfscs(event.target.value)} placeholder="2F0X1, 38F1" />
        </label>
        <label>
          <span>Duty or function</span>
          <input name="duty" value={duty} onChange={(event) => setDuty(event.target.value)} placeholder="Readiness" />
        </label>
        <fieldset className="plain-label">
          <span>Target units</span>
          <div className="check-grid">
            {orgs.map((unit) => (
              <label key={unit.id}>
                <input
                  type="checkbox"
                  name="orgId"
                  value={unit.id}
                  checked={orgIds.includes(unit.id)}
                  onChange={(event) => toggleOrg(unit.id, event.target.checked)}
                />
                <span>
                  {unit.name} · {unit.echelon}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          <span>Named individuals</span>
          <select
            name="userId"
            multiple
            size={6}
            value={userIds}
            onChange={(event) => setUserIds(Array.from(event.target.selectedOptions).map((option) => option.value))}
          >
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.rank ? `${person.rank} ` : ""}
                {person.displayName} — {person.orgName}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="plain-label">
            <span>Attachment</span>
          </span>
          <DemoUploadWarning />
          <input name="file" type="file" multiple accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.gif,.webp,.txt,application/pdf,text/plain,image/*" />
        </div>
        {error ? <p className="notice">{error}</p> : null}
        <button className="primary" type="submit" disabled={pending || matches.length === 0}>
          {pending ? "Working" : "Submit tasker"}
        </button>
      </div>
      <aside className="panel hud">
        <p className="kicker">Routing preview</p>
        <h2>Matched action officers</h2>
        {previewError ? <p className="notice">{previewError}</p> : null}
        {matches.length === 0 ? (
          <p className="meta">No action officers match these criteria yet.</p>
        ) : (
          <>
            <p>
              <strong>{matches.length}</strong> {matches.length === 1 ? "action officer" : "action officers"} will be tasked.
            </p>
            <ul className="match-list">
              {matches.map((match) => (
                <li key={match.id}>
                  <strong>
                    {match.rank ? `${match.rank} ` : ""}
                    {match.displayName}
                  </strong>
                  <span className="meta">
                    {" "}
                    · {match.orgName}
                    {match.afsc ? ` · ${match.afsc}` : ""}
                    {match.duties.length ? ` · ${match.duties.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </form>
  );
}
