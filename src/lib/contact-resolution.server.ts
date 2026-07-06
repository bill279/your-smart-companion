import type { SupabaseClient } from "@supabase/supabase-js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function norm(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function resolveContactAttendees(
  supabase: SupabaseClient,
  rawAttendees?: string[],
): Promise<{ attendees: string[]; unresolved: string[] }> {
  const raw = Array.from(new Set((rawAttendees ?? []).map((item) => item.trim()).filter(Boolean)));
  if (raw.length === 0) return { attendees: [], unresolved: [] };

  const attendees = new Set<string>();
  const names = raw.filter((item) => !EMAIL_RE.test(item));
  for (const item of raw) {
    if (EMAIL_RE.test(item)) attendees.add(item.toLowerCase());
  }
  if (names.length === 0) return { attendees: Array.from(attendees), unresolved: [] };

  const { data, error } = await supabase.from("contacts").select("name,email").order("name", { ascending: true });
  if (error) return { attendees: Array.from(attendees), unresolved: names };

  const contacts = (data ?? []).filter((contact) => contact.email);
  const unresolved: string[] = [];
  for (const name of names) {
    const q = norm(name);
    const exact = contacts.filter((contact) => norm(contact.name) === q || norm(contact.email) === q);
    const partial = contacts.filter((contact) => norm(contact.name).includes(q));
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 1) attendees.add(matches[0].email.trim().toLowerCase());
    else unresolved.push(name);
  }

  return { attendees: Array.from(attendees), unresolved };
}