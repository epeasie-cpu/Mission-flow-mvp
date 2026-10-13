import type { PersonInput } from "@/core";
import { createPersonAction, updatePersonAction } from "./actions";

type OrgOption = { id: string; name: string };
type PersonOption = { id: string; displayName: string; rank: string | null };

export function PersonForm({
  mode,
  orgs,
  people,
  person,
}: {
  mode: "create" | "edit";
  orgs: OrgOption[];
  people: PersonOption[];
  person?: PersonInput & { id: string };
}) {
  const action = mode === "create" ? createPersonAction : updatePersonAction;
  return (
    <form action={action} className="stack">
      {person ? <input type="hidden" name="userId" value={person.id} /> : null}
      <label>
        <span>Name</span>
        <input name="displayName" required defaultValue={person?.displayName ?? ""} />
      </label>
      <label>
        <span>Rank</span>
        <input name="rank" defaultValue={person?.rank ?? ""} />
      </label>
      <label>
        <span>Email</span>
        <input name="email" type="email" required defaultValue={person?.email ?? ""} placeholder="name@example.test" />
      </label>
      <label>
        <span>Org unit</span>
        <select name="orgId" required defaultValue={person?.orgId ?? ""}>
          <option value="">Select a unit</option>
          {orgs.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Duty position</span>
        <input name="billetLabel" required defaultValue={person?.billetLabel ?? ""} />
      </label>
      <label>
        <span>AFSC</span>
        <input name="afsc" defaultValue={person?.afsc ?? ""} />
      </label>
      <label>
        <span>Primary duty</span>
        <input name="primaryDuty" defaultValue={person?.primaryDuty ?? ""} />
      </label>
      <label>
        <span>Functions</span>
        <input name="functions" defaultValue={person?.functions.join(", ") ?? ""} placeholder="readiness reporting, awards packages" />
      </label>
      <label>
        <span>Supervisor</span>
        <select name="supervisorUserId" defaultValue={person?.supervisorUserId ?? ""}>
          <option value="">None</option>
          {people
            .filter((item) => item.id !== person?.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.rank ? `${item.rank} ` : ""}
                {item.displayName}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span>Leadership role</span>
        <input name="leadershipTitle" defaultValue={person?.leadershipTitle ?? ""} placeholder="Squadron Commander" />
      </label>
      <label>
        <span>Additional duties</span>
        <input name="duties" defaultValue={person?.duties.join(", ") ?? ""} placeholder="Awards Monitor, Safety Rep" />
      </label>
      <label>
        <span>Availability</span>
        <select name="availability" defaultValue={person?.availability ?? "available"}>
          <option value="available">available</option>
          <option value="tdy">tdy</option>
          <option value="deployed">deployed</option>
          <option value="leave">leave</option>
          <option value="reassigned">reassigned</option>
        </select>
      </label>
      <button className="primary" type="submit">
        {mode === "create" ? "Add person" : "Save changes"}
      </button>
    </form>
  );
}
