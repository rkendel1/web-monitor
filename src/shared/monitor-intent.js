const EXECUTION_MODES = new Set(['authenticated_browser', 'service']);
const OBSERVATION_TYPES = new Set(['string', 'number', 'boolean']);
const CONDITION_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'greater_than_or_equal',
  'less_than_or_equal',
  'exists',
  'not_exists',
  'changed',
  'increased',
  'decreased',
  'in'
]);
const OPERATOR_ALIASES = Object.freeze({
  eq: 'equals',
  ne: 'not_equals',
  lt: 'less_than',
  lte: 'less_than_or_equal',
  gt: 'greater_than',
  gte: 'greater_than_or_equal',
  under: 'less_than',
  below: 'less_than',
  over: 'greater_than',
  above: 'greater_than'
});

const ROOT_KEYS = new Set(['target', 'observation', 'condition', 'schedule', 'execution', 'notificationPolicy', 'clarification', 'confidence']);
const TARGET_KEYS = new Set(['kind', 'locator', 'selector', 'label', 'valuePath']);
const OBSERVATION_KEYS = new Set(['fields']);
const FIELD_KEYS = new Set(['name', 'type']);
const CONDITION_KEYS = new Set(['field', 'operator', 'value']);
const SCHEDULE_KEYS = new Set(['kind', 'minutes']);
const EXECUTION_KEYS = new Set(['mode']);
const NOTIFICATION_KEYS = new Set(['enabled', 'channels']);
const CLARIFICATION_KEYS = new Set(['required', 'question']);

export const monitorDraftSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['target', 'observation', 'condition', 'schedule', 'execution'],
  properties: {
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'locator'],
      properties: { kind: { const: 'web_page' }, locator: { type: 'string', format: 'uri' } }
    },
    observation: {
      type: 'object',
      additionalProperties: false,
      required: ['fields'],
      properties: { fields: { type: 'array', items: { type: 'object', additionalProperties: false } } }
    },
    condition: { type: 'object', additionalProperties: false, required: ['field', 'operator'] },
    schedule: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'minutes'],
      properties: { kind: { const: 'interval' }, minutes: { type: 'number', exclusiveMinimum: 0 } }
    },
    execution: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: { mode: { enum: [...EXECUTION_MODES] } }
    },
    notificationPolicy: { type: 'object', additionalProperties: false },
    clarification: { type: 'object', additionalProperties: false },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
});

export class MonitorIntentCapabilityError extends Error {
  constructor(message = 'Local intent compilation is unavailable') {
    super(message);
    this.name = 'MonitorIntentCapabilityError';
    this.code = 'local_model_unavailable';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, name) {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${name} contains unknown field "${key}"`);
    }
  }
}

function assertString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function rejectUnsafeText(value, name) {
  if (typeof value === 'string' && (/<script\b|javascript\s*:|on[a-z]+\s*=/i.test(value))) {
    throw new Error(`${name} contains executable content`);
  }
}

function rejectCredentialKey(key) {
  return /(?:password|secret|token|cookie|authorization|api[_-]?key|credential)/i.test(key);
}

function assertSafeValues(value, path = 'draft') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValues(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (rejectCredentialKey(key)) {
      throw new Error(`${path}.${key} contains executable credential material`);
    }
    assertSafeValues(item, `${path}.${key}`);
  }
}

function validateUrl(locator) {
  assertString(locator, 'target.locator');
  let url;
  try {
    url = new URL(locator);
  } catch {
    throw new Error('target.locator must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('target.locator must be an http(s) URL without credentials');
  }
}

function validateClarification(clarification) {
  assertObject(clarification, 'clarification');
  assertKeys(clarification, CLARIFICATION_KEYS, 'clarification');
  if (clarification.required !== true) {
    throw new Error('clarification.required must be true');
  }
  assertString(clarification.question, 'clarification.question');
  rejectUnsafeText(clarification.question, 'clarification.question');
}

export function normalizeMonitorDraft(input) {
  assertObject(input, 'MonitorDraft');
  assertKeys(input, ROOT_KEYS, 'MonitorDraft');
  assertSafeValues(input);

  if (input.clarification) {
    validateClarification(input.clarification);
  }
  if (!input.target && input.clarification?.required) {
    return { clarification: { required: true, question: input.clarification.question } };
  }

  for (const key of ['target', 'observation', 'condition', 'schedule', 'execution']) {
    if (!input[key]) {
      throw new Error(`MonitorDraft.${key} is required`);
    }
  }

  const target = input.target;
  assertObject(target, 'target');
  assertKeys(target, TARGET_KEYS, 'target');
  if (target.kind !== 'web_page') {
    throw new Error('target.kind must be web_page');
  }
  validateUrl(target.locator);
  for (const key of ['locator', 'selector', 'label', 'valuePath']) {
    if (target[key] !== undefined) {
      assertString(target[key], `target.${key}`);
      rejectUnsafeText(target[key], `target.${key}`);
    }
  }

  const observation = input.observation;
  assertObject(observation, 'observation');
  assertKeys(observation, OBSERVATION_KEYS, 'observation');
  if (!Array.isArray(observation.fields) || observation.fields.length === 0) {
    throw new Error('observation.fields must be a non-empty array');
  }
  const fields = observation.fields.map((field, index) => {
    assertObject(field, `observation.fields[${index}]`);
    assertKeys(field, FIELD_KEYS, `observation.fields[${index}]`);
    assertString(field.name, `observation.fields[${index}].name`);
    rejectUnsafeText(field.name, `observation.fields[${index}].name`);
    if (!OBSERVATION_TYPES.has(field.type)) {
      throw new Error(`Unsupported observation type: ${field.type}`);
    }
    return { name: field.name, type: field.type };
  });

  const condition = input.condition;
  assertObject(condition, 'condition');
  assertKeys(condition, CONDITION_KEYS, 'condition');
  assertString(condition.field, 'condition.field');
  const operator = OPERATOR_ALIASES[condition.operator] ?? condition.operator;
  if (!CONDITION_OPERATORS.has(operator)) {
    throw new Error(`Unsupported condition operator: ${condition.operator}`);
  }
  if (!fields.some((field) => field.name === condition.field)) {
    throw new Error('condition.field must reference an observed field');
  }
  if (!['exists', 'not_exists', 'changed', 'increased', 'decreased'].includes(operator) && condition.value === undefined) {
    throw new Error(`condition.value is required for ${operator}`);
  }
  let conditionValue = condition.value;
  if (conditionValue !== undefined && fields.find((field) => field.name === condition.field)?.type === 'number' && typeof conditionValue === 'string') {
    const match = conditionValue.match(/^\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (match) {
      conditionValue = Number(match[1]);
    }
  }
  if (conditionValue !== undefined && (typeof conditionValue === 'function' || typeof conditionValue === 'object' && conditionValue !== null && !Array.isArray(conditionValue))) {
    throw new Error('condition.value must be a primitive or array');
  }

  const schedule = input.schedule;
  assertObject(schedule, 'schedule');
  assertKeys(schedule, SCHEDULE_KEYS, 'schedule');
  if (schedule.kind !== 'interval' || !Number.isFinite(schedule.minutes) || schedule.minutes <= 0) {
    throw new Error('schedule must be a positive interval in minutes');
  }

  const execution = input.execution;
  assertObject(execution, 'execution');
  assertKeys(execution, EXECUTION_KEYS, 'execution');
  if (!EXECUTION_MODES.has(execution.mode)) {
    throw new Error(`Unsupported execution mode: ${execution.mode}`);
  }

  if (input.notificationPolicy !== undefined) {
    assertObject(input.notificationPolicy, 'notificationPolicy');
    assertKeys(input.notificationPolicy, NOTIFICATION_KEYS, 'notificationPolicy');
    if (input.notificationPolicy.enabled !== undefined && typeof input.notificationPolicy.enabled !== 'boolean') {
      throw new Error('notificationPolicy.enabled must be boolean');
    }
    if (input.notificationPolicy.channels !== undefined && (!Array.isArray(input.notificationPolicy.channels) || input.notificationPolicy.channels.some((channel) => !['in_app', 'browser'].includes(channel)))) {
      throw new Error('notificationPolicy.channels contains an unsupported channel');
    }
  }
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error('confidence must be between 0 and 1');
  }

  return {
    target: { ...target },
    observation: { fields },
    condition: { field: condition.field, operator, ...(conditionValue === undefined ? {} : { value: conditionValue }) },
    schedule: { kind: 'interval', minutes: schedule.minutes },
    execution: { mode: execution.mode },
    ...(input.notificationPolicy ? { notificationPolicy: { ...input.notificationPolicy } } : {}),
    ...(input.clarification ? { clarification: { ...input.clarification } } : {}),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence })
  };
}

export function validateMonitorDraft(input) {
  return normalizeMonitorDraft(input);
}

function modelOutput(result) {
  const value = result?.draft ?? result?.output ?? result;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('Local model returned invalid JSON');
    }
  }
  return value;
}

export function createMonitorIntentCompiler({ model, schema = monitorDraftSchema } = {}) {
  return {
    async compile(request) {
      if (!model || model.available === false || (typeof model.isAvailable === 'function' && !await model.isAvailable())) {
        throw new MonitorIntentCapabilityError();
      }
      assertObject(request, 'MonitorIntentRequest');
      assertString(request.text, 'request.text');
      if (request.context?.currentPage?.text?.length > 12_000) {
        throw new Error('context.currentPage.text exceeds the local compiler limit');
      }
      const input = {
        request,
        schema,
        instructions: 'Return only JSON matching the supplied schema. Do not include credentials, code, selectors with JavaScript, or invented condition operators.'
      };
      let result;
      if (typeof model.generate === 'function') {
        result = await model.generate(input);
      } else if (typeof model.complete === 'function') {
        result = await model.complete(input);
      } else {
        throw new MonitorIntentCapabilityError('Configured local model does not support structured generation');
      }
      return validateMonitorDraft(modelOutput(result));
    }
  };
}
