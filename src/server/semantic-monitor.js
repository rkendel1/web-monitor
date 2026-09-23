import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export const WEB_OBSERVATIONS = 'WebObservations';
export const SEMANTIC_DECISIONS = 'SemanticDecisions';

const DEFAULT_LIMITS = Object.freeze({
  maxCharacters: 20_000,
  maxHeadings: 100,
  maxLinks: 100,
  maxEvidenceItems: 200
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeTargetUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('target must be an http(s) URL without credentials');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function normalizeWebContent(html, url, limits = {}) {
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  const $ = load(String(html ?? ''));
  $('script, style, noscript, template, nav, footer, header, [aria-hidden="true"]').remove();
  const headings = $('h1,h2,h3,h4,h5,h6').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get().filter(Boolean).slice(0, bounds.maxHeadings);
  const links = $('a[href]').map((_, el) => ({
    text: $(el).text().replace(/\s+/g, ' ').trim(),
    href: new URL($(el).attr('href'), url).toString()
  })).get().slice(0, bounds.maxLinks);
  const text = $('body').text().replace(/\b(?:updated?|published?)\s*:?\s*\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, bounds.maxCharacters);
  const evidence = [
    ...headings.map((heading) => ({ type: 'heading', value: heading })),
    ...links.map((link) => ({ type: 'link', ...link }))
  ].slice(0, bounds.maxEvidenceItems);
  return { text, headings, links, evidence, truncated: text.length >= bounds.maxCharacters };
}

export function hashNormalizedContent(content) {
  return createHash('sha256').update(stable(content)).digest('hex');
}

function modelFor(application) {
  return application.semanticDecision
    ?? application.semanticModel
    ?? application.model?.semanticDecision
    ?? application.model;
}

export async function executeMonitor(application, monitorId, options = {}) {
  const monitor = await application.state.collection('Monitors').get(monitorId);
  if (!monitor || monitor.deletedAt) throw Object.assign(new Error('Monitor not found'), { code: 'NOT_FOUND', status: 404 });
  if (monitor.enabled === false || monitor.status === 'paused') return { status: 'disabled', monitorId };
  const target = typeof monitor.target === 'string' ? monitor.target : monitor.target?.locator;
  const url = normalizeTargetUrl(target ?? monitor.url);
  const fetchImpl = options.fetch ?? application.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  if (!response.ok) throw Object.assign(new Error(`Fetch failed with status ${response.status}`), { code: 'FETCH_FAILED', status: 502 });
  const content = normalizeWebContent(await response.text(), url, options.limits);
  const contentHash = hashNormalizedContent(content);
  const previous = (await application.state.collection(WEB_OBSERVATIONS).find({ monitorId }))
    .sort((a, b) => String(b.retrievedAt).localeCompare(String(a.retrievedAt)))[0];
  const checkedAt = new Date().toISOString();
  await application.state.collection('Monitors').update(monitorId, {
    lastCheckedAt: checkedAt,
    updatedAt: checkedAt
  });
  if (previous?.contentHash === contentHash) return { status: 'unchanged', monitorId, contentHash };

  const observationId = `${monitorId}:${contentHash}`;
  const observations = application.state.collection(WEB_OBSERVATIONS);
  const observation = {
    id: observationId, monitorId, url, retrievedAt: checkedAt, contentHash, content,
    metadata: { status: response.status, contentType: response.headers.get('content-type') ?? '' }
  };
  if (!await observations.get(observationId)) await observations.insert(observation, observationId);
  await application.state.collection('Monitors').update(monitorId, {
    lastObservedAt: checkedAt,
    updatedAt: checkedAt
  });

  const decisions = application.state.collection(SEMANTIC_DECISIONS);
  const decisionId = `${observationId}:decision`;
  let decision = await decisions.get(decisionId);
  if (!decision) {
    const model = modelFor(application);
    if (!model || typeof (model.decide ?? model.generate) !== 'function') {
      decision = {
        id: decisionId, observationId, decision: { status: 'capability_error', action: 'record' },
        rationale: 'Local semantic inference is unavailable', confidence: 0, model: 'unavailable', createdAt: checkedAt
      };
    } else {
      const decide = model.decide ?? model.generate;
      try {
        const result = await decide.call(model, {
          monitor: { name: monitor.name, description: monitor.description, instructions: monitor.instructions },
          observation: content
        });
        decision = {
          id: decisionId, observationId, decision: result, rationale: result.reason ?? result.rationale ?? '',
          confidence: result.confidence ?? null, model: result.model ?? model.name ?? 'local', createdAt: checkedAt
        };
      } catch (error) {
        decision = {
          id: decisionId, observationId,
          decision: { status: 'model_error', action: 'record' },
          rationale: 'Local semantic inference failed', confidence: 0, model: model.name ?? 'local', createdAt: checkedAt
        };
      }
    }
    await decisions.insert(decision, decisionId);
  }
  await application.state.collection('Monitors').update(monitorId, {
    lastDecisionAt: decision.createdAt, updatedAt: decision.createdAt
  });
  return { status: 'changed', monitorId, observation, decision };
}
