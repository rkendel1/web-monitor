import { load } from 'cheerio';
import { evaluateCondition, normalizeText, parseCurrencyValue } from '../shared/conditions.js';

function firstMatchingElement($, matcher) {
  const candidates = $('body *').toArray();
  for (const element of candidates) {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }

    if (matcher(text, element)) {
      return { element, text };
    }
  }

  return null;
}

function textPresence($, text) {
  const bodyText = normalizeText($('body').text());
  return bodyText.includes(normalizeText(text));
}

export function observeHtml(monitor, html) {
  const $ = load(html);
  const { condition, target } = monitor;

  switch (condition.type) {
    case 'numeric_threshold': {
      let selectedText = '';

      if (target?.selector) {
        selectedText = $(target.selector).first().text().replace(/\s+/g, ' ').trim();
      }

      if (!selectedText) {
        const match = firstMatchingElement($, (text) => /\$\s*\d/.test(text) || /price/i.test(text));
        selectedText = match?.text ?? '';
      }

      return {
        valueText: selectedText,
        numericValue: parseCurrencyValue(selectedText),
        selector: target?.selector ?? null
      };
    }
    case 'text_appears':
    case 'text_disappears':
      return {
        valueText: condition.text,
        present: textPresence($, condition.text)
      };
    case 'value_changes': {
      let selectedText = '';
      if (target?.selector) {
        selectedText = $(target.selector).first().text().replace(/\s+/g, ' ').trim();
      }
      if (!selectedText && target?.label) {
        const match = firstMatchingElement($, (text) => normalizeText(text).includes(normalizeText(target.label)));
        selectedText = match?.text ?? '';
      }
      return {
        valueText: selectedText,
        selector: target?.selector ?? null
      };
    }
    case 'element_appears': {
      let present = false;
      let selectedText = '';
      if (target?.selector) {
        const node = $(target.selector).first();
        present = node.length > 0;
        selectedText = node.text().replace(/\s+/g, ' ').trim();
      }
      if (!present) {
        const match = firstMatchingElement($, (text, element) => {
          const tagName = element.tagName?.toLowerCase();
          const allowedTag = condition.element === 'button' ? tagName === 'button' || tagName === 'a' : true;
          return allowedTag && normalizeText(text).includes(normalizeText(condition.text));
        });
        present = Boolean(match);
        selectedText = match?.text ?? '';
      }
      return {
        present,
        valueText: selectedText,
        selector: target?.selector ?? null
      };
    }
    default:
      return { valueText: '' };
  }
}

export function evaluateObservation(monitor, observation, previousObservation) {
  return evaluateCondition(monitor.condition, observation, previousObservation);
}
