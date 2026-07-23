import { getEnv } from "@stopgap/core/env";

type Fetcher = typeof fetch;

export interface TherapeuticClass {
  classId: string;
  className: string;
  classType: string;
}

/** Resolve RxNorm concept ids for a drug name. REAL NLM RxNorm API (PROJECT_PLAN §5). */
export async function getRxcuiByName(
  name: string,
  opts: { fetchImpl?: Fetcher } = {},
): Promise<string[]> {
  const env = getEnv();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${env.RXNORM_BASE_URL}/REST/rxcui.json?name=${encodeURIComponent(name)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`RxNorm rxcui lookup failed: ${res.status}`);
  const body = (await res.json()) as { idGroup?: { rxnormId?: string[] } };
  return body.idGroup?.rxnormId ?? [];
}

/** Fetch therapeutic classes for an rxcui (ATC by default). REAL RxNorm/RxClass API. */
export async function getTherapeuticClasses(
  rxcui: string,
  opts: { relaSource?: string; fetchImpl?: Fetcher } = {},
): Promise<TherapeuticClass[]> {
  const env = getEnv();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const relaSource = opts.relaSource ?? "ATC";
  const url = `${env.RXNORM_BASE_URL}/REST/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}&relaSource=${relaSource}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`RxNorm class lookup failed: ${res.status}`);
  const body = (await res.json()) as {
    rxclassDrugInfoList?: { rxclassDrugInfo?: Array<{ rxclassMinConceptItem?: TherapeuticClass }> };
  };
  const items = body.rxclassDrugInfoList?.rxclassDrugInfo ?? [];
  const seen = new Set<string>();
  const out: TherapeuticClass[] = [];
  for (const it of items) {
    const c = it.rxclassMinConceptItem;
    if (c && !seen.has(c.classId)) {
      seen.add(c.classId);
      out.push(c);
    }
  }
  return out;
}
