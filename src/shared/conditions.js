const CURRENCY_PATTERN = /(?:\$|usd\s*)?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/i;
const INTERVAL_LABELS = {
  '15m': 'Every 15 minutes',
  '30m': 'Every 30 minutes',
  '1h': 'Every hour',
  '6h': 'Every 6 hours',
  '12h': 'Every 12 hours',
  '1d': 'Every day'
};

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function parseCurrencyValue(value) {
  const match = String(value ?? '').match(CURRENCY_PATTERN);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function conditionLabel(condition) {
  switch (condition.type) {
    case 'numeric_threshold':
      return `${condition.target} ${condition.operator === 'lt' ? '<' : '>'} $${condition.value}`;
    case 'text_appears':
      return `page contains "${condition.text}"`;
    case 'text_disappears':
      return `page no longer contains "${condition.text}"`;
    case 'value_changes':
      return `${condition.target} changed`;
    case 'element_appears':
      return `${condition.element ?? 'element'} "${condition.text}" appears`;
    default:
      return condition.type;
  }
}

export function intervalLabel(interval) {
  return INTERVAL_LABELS[interval] ?? interval;
}

export function normalizeInterval(interval) {
  if (INTERVAL_LABELS[interval]) {
    return interval;
  }

  if (/^\d+[smhd]$/.test(interval)) {
    return interval;
  }

  throw new Error('Unsupported schedule interval');
}

export function parseConditionInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('Enter a condition to monitor');
  }

  const priceBelow = raw.match(/price\s+(?:drops\s+)?below\s+\$?([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (priceBelow) {
    return {
      type: 'numeric_threshold',
      target: 'price',
      operator: 'lt',
      value: Number(priceBelow[1]),
      raw
    };
  }

  const disappears = raw.match(/(?:page\s+)?(?:no\s+longer\s+contains|text\s+disappears)\s+["'](.+?)["']/i);
  if (disappears) {
    return {
      type: 'text_disappears',
      text: disappears[1],
      raw
    };
  }

  const contains = raw.match(/(?:page\s+)?contains\s+["'](.+?)["']/i);
  if (contains) {
    return {
      type: 'text_appears',
      text: contains[1],
      raw
    };
  }

  const valueChanges = raw.match(/^(.+?)\s+changed$/i);
  if (valueChanges) {
    return {
      type: 'value_changes',
      target: valueChanges[1].trim(),
      raw
    };
  }

  const elementAppears = raw.match(/(?:(button|element)\s+)?["'](.+?)["']\s+appears$/i);
  if (elementAppears) {
    return {
      type: 'element_appears',
      element: elementAppears[1] || 'element',
      text: elementAppears[2],
      raw
    };
  }

  throw new Error('Supported MVP conditions: text appears/disappears, price below a threshold, value changes, and element appears');
}

export function evaluateCondition(condition, observation, previousObservation) {
  switch (condition.type) {
    case 'numeric_threshold': {
      const numericValue = observation?.numericValue;
      const triggered = Number.isFinite(numericValue) && (condition.operator === 'lt'
        ? numericValue < condition.value
        : numericValue > condition.value);

      return {
        triggered,
        summary: numericValue == null
          ? `Unable to read ${condition.target}`
          : `${condition.target} is ${numericValue}`
      };
    }
    case 'text_appears':
      return {
        triggered: Boolean(observation?.present),
        summary: observation?.present ? `Found "${condition.text}"` : `"${condition.text}" not found`
      };
    case 'text_disappears':
      return {
        triggered: observation?.present === false,
        summary: observation?.present === false ? `"${condition.text}" disappeared` : `"${condition.text}" still present`
      };
    case 'value_changes': {
      const baseline = previousObservation?.valueText ?? condition.initialValue ?? null;
      const current = observation?.valueText ?? null;
      return {
        triggered: Boolean(baseline && current && baseline !== current),
        summary: baseline && current ? `${condition.target} is ${current}` : `Tracking ${condition.target}`
      };
    }
    case 'element_appears':
      return {
        triggered: Boolean(observation?.present),
        summary: observation?.present ? `Found ${condition.element ?? 'element'} "${condition.text}"` : `${condition.element ?? 'element'} "${condition.text}" not found`
      };
    default:
      return {
        triggered: false,
        summary: 'Unsupported condition type'
      };
  }
}
