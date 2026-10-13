import { eq } from "drizzle-orm";
import { additionalDuty, appUser, org, roleGrant } from "../db/schema";
import type { CoreDb } from "./db";
import { inTx } from "./db";

/** Fictional pitch-demo wing. */
export const NOTIONAL_WING_SHORT = "N99W";
export const NOTIONAL_WING_NAME = "99th Notional Wing"; // mf-banned-ok: fictional pitch-demo wing

type Echelon = "wing" | "group" | "squadron" | "flight";
type Availability = "available" | "tdy" | "deployed" | "leave" | "reassigned";
type GrantRole = "functional_owner" | "supervisor" | "tasking_authority" | "approver" | "system_admin";

const ORGS: { code: string; name: string; echelon: Echelon; parent: string | null }[] = [
  { code: "N99W", name: NOTIONAL_WING_NAME, echelon: "wing", parent: null },
  { code: "NOG", name: "Notional Operations Group", echelon: "group", parent: "N99W" },
  { code: "NMSG", name: "Notional Mission Support Group", echelon: "group", parent: "N99W" },
  { code: "NLS", name: "Notional Logistics Squadron", echelon: "squadron", parent: "NOG" },
  { code: "NFS", name: "Notional Force Support Squadron", echelon: "squadron", parent: "NOG" },
  { code: "NCS", name: "Notional Communications Squadron", echelon: "squadron", parent: "NOG" },
  { code: "NCE", name: "Notional Civil Engineer Squadron", echelon: "squadron", parent: "NMSG" },
  { code: "NSS", name: "Notional Security Squadron", echelon: "squadron", parent: "NMSG" },
  { code: "NLS-RDF", name: "Notional Readiness Flight", echelon: "flight", parent: "NLS" },
  { code: "NLS-DIF", name: "Notional Distribution Flight", echelon: "flight", parent: "NLS" },
  { code: "NFS-PSF", name: "Notional Personnel Flight", echelon: "flight", parent: "NFS" },
  { code: "NFS-SUF", name: "Notional Sustainment Flight", echelon: "flight", parent: "NFS" },
  { code: "NCS-NWF", name: "Notional Networks Flight", echelon: "flight", parent: "NCS" },
  { code: "NCS-PLF", name: "Notional Plans Flight", echelon: "flight", parent: "NCS" },
  { code: "NCE-OPF", name: "Notional Engineer Operations Flight", echelon: "flight", parent: "NCE" },
  { code: "NCE-RDO", name: "Notional Engineer Readiness Office", echelon: "flight", parent: "NCE" },
  { code: "NSS-PLF", name: "Notional Security Plans Flight", echelon: "flight", parent: "NSS" },
  { code: "NSS-TRO", name: "Notional Training Office", echelon: "flight", parent: "NSS" },
  { code: "N99-CAO", name: "Notional Commander's Action Office", echelon: "flight", parent: "N99W" },
];

type Person = {
  email: string;
  name: string;
  rank: string;
  org: string;
  billet: string;
  afsc: string;
  duty: string;
  functions: string[];
  extra: string[];
  supervisor?: string;
  leadership?: string;
  featured?: boolean;
  availability?: Availability;
};

const PEOPLE: Person[] = [
  { email: "avery.keene@example.test", name: "Avery Keene", rank: "Brig Gen", org: "N99W", billet: "Wing commander", afsc: "10C0", duty: "Wing command", functions: ["command"], extra: [], leadership: "Wing Commander" },
  { email: "morgan.calder@example.test", name: "Morgan Calder", rank: "Col", org: "N99W", billet: "Pitch demo · Wing tasking authority", afsc: "16R3", duty: "Tasking", functions: ["tasking"], extra: [], supervisor: "avery.keene@example.test", featured: true },
  { email: "eden.marlow@example.test", name: "Eden Marlow", rank: "Maj", org: "N99W", billet: "Awards program manager", afsc: "38F1", duty: "Awards management", functions: ["awards"], extra: [], supervisor: "avery.keene@example.test", leadership: "Awards Program Manager" },
  { email: "jules.adler@example.test", name: "Jules Adler", rank: "GS-12", org: "N99W", billet: "System administrator", afsc: "3F5X1", duty: "Directory administration", functions: ["directory"], extra: [], supervisor: "avery.keene@example.test" },
  { email: "lane.ortiz@example.test", name: "Lane Ortiz", rank: "Capt", org: "N99-CAO", billet: "Action officer", afsc: "16R3", duty: "Tasking desk", functions: ["tasker intake"], extra: [], supervisor: "morgan.calder@example.test" },
  { email: "ada.frost@example.test", name: "Ada Frost", rank: "Maj", org: "N99-CAO", billet: "Deputy tasking officer", afsc: "16R3", duty: "Task management", functions: ["suspense tracking"], extra: ["Unit Deployment Manager"], supervisor: "morgan.calder@example.test" },
  { email: "beau.ilin@example.test", name: "Beau Ilin", rank: "TSgt", org: "N99-CAO", billet: "Administration NCO", afsc: "3F5X1", duty: "Administration", functions: ["records"], extra: ["Records Custodian"], supervisor: "lane.ortiz@example.test" },
  { email: "cora.voss@example.test", name: "Cora Voss", rank: "Amn", org: "N99-CAO", billet: "Administration specialist", afsc: "3F5X1", duty: "Administration", functions: ["correspondence"], extra: ["Fitness Monitor"], supervisor: "beau.ilin@example.test" },
  { email: "harper.voss@example.test", name: "Harper Voss", rank: "Col", org: "NOG", billet: "Operations group commander", afsc: "10C0", duty: "Group command", functions: ["command"], extra: [], supervisor: "avery.keene@example.test", leadership: "Operations Group Commander" },
  { email: "sloane.harlow@example.test", name: "Sloane Harlow", rank: "Lt Col", org: "NLS", billet: "Pitch demo · Squadron commander", afsc: "21R3", duty: "Squadron command", functions: ["supervision"], extra: [], supervisor: "harper.voss@example.test", leadership: "Squadron Commander", featured: true },
  { email: "kit.ramsey@example.test", name: "Kit Ramsey", rank: "MSgt", org: "NLS-RDF", billet: "Flight chief", afsc: "2F0X1", duty: "Readiness", functions: ["flight leadership"], extra: ["Safety Rep"], supervisor: "sloane.harlow@example.test", leadership: "Flight Chief" },
  { email: "blake.pell@example.test", name: "Blake Pell", rank: "Capt", org: "NLS-RDF", billet: "Pitch demo · Awards Monitor", afsc: "2F0X1", duty: "Readiness", functions: ["readiness reporting"], extra: ["Awards Monitor"], supervisor: "kit.ramsey@example.test", featured: true },
  { email: "dax.keene@example.test", name: "Dax Keene", rank: "2d Lt", org: "NLS-RDF", billet: "Readiness analyst", afsc: "21R3", duty: "Readiness analysis", functions: ["data calls"], extra: ["Vehicle Control Officer"], supervisor: "kit.ramsey@example.test" },
  { email: "cyrus.hale@example.test", name: "Cyrus Hale", rank: "TSgt", org: "NLS-DIF", billet: "Flight chief", afsc: "2T2X1", duty: "Distribution", functions: ["flight leadership"], extra: [], supervisor: "sloane.harlow@example.test", leadership: "Flight Chief" },
  { email: "arlo.finch@example.test", name: "Arlo Finch", rank: "SSgt", org: "NLS-DIF", billet: "Deployment NCO", afsc: "2T2X1", duty: "Distribution", functions: ["cargo"], extra: ["Unit Deployment Manager"], supervisor: "cyrus.hale@example.test" },
  { email: "bess.lang@example.test", name: "Bess Lang", rank: "SrA", org: "NLS-DIF", billet: "Distribution specialist", afsc: "2T2X1", duty: "Distribution", functions: ["pallet build"], extra: ["Safety Rep"], supervisor: "cyrus.hale@example.test" },
  { email: "ellis.shore@example.test", name: "Ellis Shore", rank: "Lt Col", org: "NFS", billet: "Force support commander", afsc: "38F1", duty: "Squadron command", functions: ["supervision"], extra: [], supervisor: "harper.voss@example.test", leadership: "Squadron Commander" },
  { email: "nia.brock@example.test", name: "Nia Brock", rank: "MSgt", org: "NFS-PSF", billet: "Flight chief", afsc: "3F5X1", duty: "Personnel", functions: ["flight leadership"], extra: [], supervisor: "ellis.shore@example.test", leadership: "Flight Chief" },
  { email: "wynn.okada@example.test", name: "Wynn Okada", rank: "Capt", org: "NFS-PSF", billet: "Personnel officer", afsc: "38F1", duty: "Personnel", functions: ["customer support"], extra: ["Awards Monitor"], supervisor: "nia.brock@example.test" },
  { email: "omari.quinn@example.test", name: "Omari Quinn", rank: "SSgt", org: "NFS-PSF", billet: "Personnel specialist", afsc: "3F5X1", duty: "Personnel", functions: ["records"], extra: ["Unit Deployment Manager"], supervisor: "nia.brock@example.test" },
  { email: "quill.sato@example.test", name: "Quill Sato", rank: "TSgt", org: "NFS-SUF", billet: "Flight chief", afsc: "3F1X1", duty: "Sustainment", functions: ["flight leadership"], extra: [], supervisor: "ellis.shore@example.test", leadership: "Flight Chief" },
  { email: "pippa.reed@example.test", name: "Pippa Reed", rank: "A1C", org: "NFS-SUF", billet: "Sustainment specialist", afsc: "3F1X1", duty: "Sustainment", functions: ["services"], extra: ["Safety Rep"], supervisor: "quill.sato@example.test", availability: "leave" },
  { email: "micah.brandt@example.test", name: "Micah Brandt", rank: "Lt Col", org: "NCS", billet: "Communications commander", afsc: "17D3", duty: "Squadron command", functions: ["supervision"], extra: [], supervisor: "harper.voss@example.test", leadership: "Squadron Commander" },
  { email: "oona.frost@example.test", name: "Oona Frost", rank: "MSgt", org: "NCS-NWF", billet: "Flight chief", afsc: "1D7X1", duty: "Networks", functions: ["flight leadership"], extra: [], supervisor: "micah.brandt@example.test", leadership: "Flight Chief" },
  { email: "nico.vale@example.test", name: "Nico Vale", rank: "1st Lt", org: "NCS-NWF", billet: "Network officer", afsc: "17D3", duty: "Networks", functions: ["plans"], extra: ["Awards Monitor"], supervisor: "oona.frost@example.test" },
  { email: "perry.dunn@example.test", name: "Perry Dunn", rank: "SSgt", org: "NCS-NWF", billet: "Network specialist", afsc: "1D7X1", duty: "Networks", functions: ["operations"], extra: ["Safety Rep"], supervisor: "oona.frost@example.test" },
  { email: "rhett.cole@example.test", name: "Rhett Cole", rank: "Capt", org: "NCS-PLF", billet: "Plans officer", afsc: "17D3", duty: "Communications plans", functions: ["planning"], extra: ["Unit Deployment Manager"], supervisor: "micah.brandt@example.test" },
  { email: "indigo.pell@example.test", name: "Indigo Pell", rank: "Col", org: "NMSG", billet: "Mission support group commander", afsc: "10C0", duty: "Group command", functions: ["command"], extra: [], supervisor: "avery.keene@example.test", leadership: "Mission Support Group Commander" },
  { email: "remy.solis@example.test", name: "Remy Solis", rank: "Lt Col", org: "NCE", billet: "Engineer commander", afsc: "32E3", duty: "Squadron command", functions: ["supervision"], extra: [], supervisor: "indigo.pell@example.test", leadership: "Squadron Commander" },
  { email: "theo.march@example.test", name: "Theo March", rank: "MSgt", org: "NCE-OPF", billet: "Flight chief", afsc: "3E5X1", duty: "Engineer operations", functions: ["flight leadership"], extra: [], supervisor: "remy.solis@example.test", leadership: "Flight Chief" },
  { email: "sage.ibarra@example.test", name: "Sage Ibarra", rank: "Capt", org: "NCE-OPF", billet: "Engineer officer", afsc: "32E3", duty: "Engineering", functions: ["projects"], extra: ["Awards Monitor"], supervisor: "theo.march@example.test" },
  { email: "uma.bright@example.test", name: "Uma Bright", rank: "SSgt", org: "NCE-OPF", billet: "Engineer specialist", afsc: "3E5X1", duty: "Engineering", functions: ["work orders"], extra: ["Safety Rep"], supervisor: "theo.march@example.test" },
  { email: "vera.cho@example.test", name: "Vera Cho", rank: "TSgt", org: "NCE-RDO", billet: "Readiness NCO", afsc: "3E5X1", duty: "Engineer readiness", functions: ["readiness"], extra: ["Unit Deployment Manager"], supervisor: "remy.solis@example.test" },
  { email: "tatum.briggs@example.test", name: "Tatum Briggs", rank: "Lt Col", org: "NSS", billet: "Security commander", afsc: "31P3", duty: "Squadron command", functions: ["supervision"], extra: [], supervisor: "indigo.pell@example.test", leadership: "Squadron Commander" },
  { email: "wes.nguyen@example.test", name: "Wes Nguyen", rank: "SMSgt", org: "NSS-PLF", billet: "Flight chief", afsc: "3P0X1", duty: "Security plans", functions: ["flight leadership"], extra: [], supervisor: "tatum.briggs@example.test", leadership: "Flight Chief" },
  { email: "lou.mercer@example.test", name: "Lou Mercer", rank: "1st Lt", org: "NSS-PLF", billet: "Security officer", afsc: "31P3", duty: "Security plans", functions: ["plans"], extra: ["Awards Monitor"], supervisor: "wes.nguyen@example.test" },
  { email: "yara.bloom@example.test", name: "Yara Bloom", rank: "SSgt", org: "NSS-TRO", billet: "Training NCO", afsc: "3P0X1", duty: "Security training", functions: ["training"], extra: ["Safety Rep"], supervisor: "wes.nguyen@example.test" },
  { email: "zed.parker@example.test", name: "Zed Parker", rank: "SrA", org: "NSS-TRO", billet: "Security specialist", afsc: "3P0X1", duty: "Entry control", functions: ["posts"], extra: ["Unit Deployment Manager"], supervisor: "wes.nguyen@example.test", availability: "deployed" },
];

const GRANTS: { email: string; role: GrantRole; scope: string | null; portfolio?: string }[] = [
  { email: "morgan.calder@example.test", role: "tasking_authority", scope: "N99W" },
  { email: "jules.adler@example.test", role: "system_admin", scope: null },
  { email: "avery.keene@example.test", role: "approver", scope: "N99W" },
  { email: "eden.marlow@example.test", role: "functional_owner", scope: null, portfolio: "notional awards" },
  { email: "harper.voss@example.test", role: "supervisor", scope: "NOG" },
  { email: "sloane.harlow@example.test", role: "supervisor", scope: "NLS" },
  { email: "ellis.shore@example.test", role: "supervisor", scope: "NFS" },
  { email: "micah.brandt@example.test", role: "supervisor", scope: "NCS" },
  { email: "indigo.pell@example.test", role: "supervisor", scope: "NMSG" },
  { email: "remy.solis@example.test", role: "supervisor", scope: "NCE" },
  { email: "tatum.briggs@example.test", role: "supervisor", scope: "NSS" },
];

export async function seedNotionalDirectory(db: CoreDb): Promise<{ inserted: boolean; wingOrgId: string }> {
  const [existing] = await db.select({ id: org.id }).from(org).where(eq(org.shortCode, NOTIONAL_WING_SHORT)).limit(1);
  if (existing) return { inserted: false, wingOrgId: existing.id };
  return inTx(db, async (tx) => {
    const orgIds = new Map<string, string>();
    for (const item of ORGS) {
      const [row] = await tx
        .insert(org)
        .values({
          name: item.name,
          shortCode: item.code,
          echelon: item.echelon,
          parentOrgId: item.parent ? orgIds.get(item.parent) ?? null : null,
          missionCodes: [],
        })
        .returning({ id: org.id });
      if (!row) throw new Error(`org insert failed: ${item.code}`);
      orgIds.set(item.code, row.id);
    }
    const userIds = new Map<string, string>();
    for (const person of PEOPLE) {
      const orgId = orgIds.get(person.org);
      if (!orgId) throw new Error(`missing org ${person.org}`);
      const [row] = await tx
        .insert(appUser)
        .values({
          displayName: person.name,
          email: person.email,
          orgId,
          billetLabel: person.billet,
          rank: person.rank,
          afsc: person.afsc,
          primaryDuty: person.duty,
          functions: person.functions,
          leadershipTitle: person.leadership ?? null,
          featured: person.featured ?? false,
          availability: person.availability ?? "available",
        })
        .returning({ id: appUser.id });
      if (!row) throw new Error(`user insert failed: ${person.email}`);
      userIds.set(person.email, row.id);
    }
    for (const person of PEOPLE) {
      if (!person.supervisor) continue;
      const supervisorUserId = userIds.get(person.supervisor);
      if (!supervisorUserId) throw new Error(`missing supervisor ${person.supervisor}`);
      await tx.update(appUser).set({ supervisorUserId }).where(eq(appUser.id, userIds.get(person.email)!));
    }
    for (const person of PEOPLE) {
      const userId = userIds.get(person.email);
      if (!userId) continue;
      for (const name of person.extra) {
        await tx.insert(additionalDuty).values({ userId, name });
      }
    }
    const grantedBy = userIds.get("jules.adler@example.test");
    if (!grantedBy) throw new Error("missing directory admin");
    for (const grant of GRANTS) {
      const userId = userIds.get(grant.email);
      if (!userId) throw new Error(`missing grant user ${grant.email}`);
      await tx.insert(roleGrant).values({
        userId,
        role: grant.role,
        scopeOrgId: grant.scope ? orgIds.get(grant.scope) ?? null : null,
        portfolio: grant.portfolio ?? null,
        grantedBy,
      });
    }
    return { inserted: true, wingOrgId: orgIds.get(NOTIONAL_WING_SHORT)! };
  });
}
