// src/parse_pdf.ts (disabled)
// PDF parsing is disabled in XML-only mode. We keep stubs to avoid dangling imports.
import type { InterfaceInfo } from './parse_watchguard';
import type { UnifiedPolicy } from './xml_to_upolicy';

export async function parseWatchGuardPdf(_file: File): Promise<{ interfaces: InterfaceInfo[]; reportText: string }>{
  throw new Error('PDF support is disabled in this build.');
}

export function parsePoliciesFromReport(_text: string): UnifiedPolicy[] {
  return [];
}
