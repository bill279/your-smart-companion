// Client-side registry of documents the assistant has generated in-chat.
// Kept in memory + sessionStorage so a reload within the session still resolves
// artifact IDs referenced in message content (e.g. `[[artifact:abc123]]`).

import { saveAs } from "file-saver";

export type Artifact = {
  id: string;
  filename: string;
  mimeType: string;
  /** base64-encoded file bytes (no data-url prefix). */
  base64: string;
  /** File size in bytes. */
  size: number;
  /** Human label for the format ("PDF", "Word", etc.). */
  formatLabel: string;
  createdAt: number;
};

const memory = new Map<string, Artifact>();
const STORAGE_KEY = "bpa.artifacts.v1";
const MAX_KEEP = 12;
// localStorage survives reloads and new tabs (unlike sessionStorage), so
// artifact preview cards keep working after a refresh.

function loadFromStorage(): Map<string, Artifact> {
  if (typeof window === "undefined") return memory;
  if (memory.size > 0) return memory;
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return memory;
    const arr = JSON.parse(raw) as Artifact[];
    for (const a of arr) memory.set(a.id, a);
  } catch {
    // ignore
  }
  return memory;
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    const arr = Array.from(memory.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_KEEP);
    memory.clear();
    for (const a of arr) memory.set(a.id, a);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // storage may be full; drop silently
  }
}

function newId() {
  return `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function saveArtifact(a: Omit<Artifact, "id" | "createdAt">): Artifact {
  loadFromStorage();
  const full: Artifact = { ...a, id: newId(), createdAt: Date.now() };
  memory.set(full.id, full);
  persist();
  return full;
}

export function getArtifact(id: string): Artifact | undefined {
  loadFromStorage();
  return memory.get(id);
}

export function getLatestArtifact(): Artifact | undefined {
  loadFromStorage();
  let latest: Artifact | undefined;
  for (const a of memory.values()) {
    if (!latest || a.createdAt > latest.createdAt) latest = a;
  }
  return latest;
}

export function downloadArtifact(a: Artifact) {
  saveAs(base64ToBlob(a.base64, a.mimeType), a.filename);
}

/** Marker inserted into an assistant message to render the artifact card. */
export function artifactMarker(id: string) {
  return `[[artifact:${id}]]`;
}

export const ARTIFACT_MARKER_RE = /\[\[artifact:([a-z0-9_]+)\]\]/gi;