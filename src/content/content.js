function visibleText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cssSelector(element) {
  if (!(element instanceof Element)) {
    return null;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    let selector = current.localName;
    if (current.id) {
      selector += `#${CSS.escape(current.id)}`;
      parts.unshift(selector);
      break;
    }

    const className = Array.from(current.classList).slice(0, 2).map((value) => `.${CSS.escape(value)}`).join('');
    selector += className;
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((child) => child.localName === current.localName)
      : [];

    if (siblings.length > 1) {
      selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.length ? parts.join(' > ') : null;
}

function firstCurrencyCandidate() {
  const elements = Array.from(document.body.querySelectorAll('body *'));
  for (const element of elements) {
    const text = visibleText(element.textContent);
    if (text && /\$\s*\d/.test(text)) {
      return {
        selector: cssSelector(element),
        valueText: text
      };
    }
  }

  return {
    selector: null,
    valueText: ''
  };
}

function findElementByText(text, onlyButtons = false) {
  const normalized = visibleText(text).toLowerCase();
  const selector = onlyButtons ? 'button, a, [role="button"]' : 'body *';
  const elements = Array.from(document.querySelectorAll(selector));
  for (const element of elements) {
    const elementText = visibleText(element.textContent).toLowerCase();
    if (elementText && elementText.includes(normalized)) {
      return {
        selector: cssSelector(element),
        valueText: visibleText(element.textContent),
        present: true
      };
    }
  }

  return {
    selector: null,
    valueText: '',
    present: false
  };
}

function captureDraft(condition) {
  const pageText = visibleText(document.body.innerText);

  switch (condition.type) {
    case 'numeric_threshold': {
      const candidate = firstCurrencyCandidate();
      return {
        target: {
          selector: candidate.selector,
          label: condition.target
        },
        initialObservation: {
          valueText: candidate.valueText,
          numericValue: Number.parseFloat((candidate.valueText.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/)?.[1] || '').replace(/,/g, '')) || null,
          selector: candidate.selector
        }
      };
    }
    case 'text_appears':
    case 'text_disappears':
      return {
        target: {
          text: condition.text
        },
        initialObservation: {
          valueText: condition.text,
          present: pageText.toLowerCase().includes(condition.text.toLowerCase())
        }
      };
    case 'value_changes': {
      const match = findElementByText(condition.target, false);
      return {
        target: {
          selector: match.selector,
          label: condition.target
        },
        initialObservation: {
          valueText: match.valueText || condition.target,
          selector: match.selector
        }
      };
    }
    case 'element_appears': {
      const match = findElementByText(condition.text, condition.element === 'button');
      return {
        target: {
          selector: match.selector,
          text: condition.text,
          element: condition.element
        },
        initialObservation: {
          valueText: match.valueText,
          present: match.present,
          selector: match.selector
        }
      };
    }
    default:
      return {
        target: {},
        initialObservation: {
          valueText: ''
        }
      };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'APPPORT_CAPTURE_MONITOR_DRAFT') {
    return;
  }

  try {
    const draft = captureDraft(message.condition);
    sendResponse({
      ok: true,
      data: {
        url: location.href,
        title: document.title,
        ...draft,
        notes: document.querySelectorAll('script').length > 20
          ? 'Client-side rendered pages may require additional extraction work beyond this MVP.'
          : ''
      }
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return true;
});
