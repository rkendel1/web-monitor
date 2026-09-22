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

function detectAuthStateOnDom() {
  const hasPasswordInput = document.querySelector('input[type="password"]') !== null;
  const url = location.href;
  const isLoginUrl = url.toLowerCase().includes('login') || 
                      url.toLowerCase().includes('signin') || 
                      url.toLowerCase().includes('signup') || 
                      url.toLowerCase().includes('auth') || 
                      url.toLowerCase().includes('sign-in') || 
                      url.toLowerCase().includes('sign-out') || 
                      url.toLowerCase().includes('logout');
  
  if (hasPasswordInput || isLoginUrl) {
    return 'required';
  }
  
  const bodyText = document.body.innerText || '';
  const hasLogout = /sign\s*out/i.test(bodyText) || 
                    /log\s*out/i.test(bodyText) || 
                    /logout/i.test(bodyText) || 
                    /logoff/i.test(bodyText) || 
                    /my\s*account/i.test(bodyText) || 
                    /user\s*profile/i.test(bodyText) || 
                    /dashboard/i.test(bodyText) || 
                    /welcome,\s*\w+/i.test(bodyText);
  if (hasLogout) {
    return 'authenticated';
  }
  
  return 'public';
}

function observePage(condition, target) {
  const pageText = visibleText(document.body.innerText);
  const authState = detectAuthStateOnDom();

  if (authState === 'required') {
    return {
      authentication: 'authentication_required',
      observedAt: new Date().toISOString(),
      url: location.href,
      execution: 'authenticated_browser'
    };
  }

  let observation = {};

  switch (condition.type) {
    case 'numeric_threshold': {
      let selectedText = '';
      if (target?.selector) {
        const element = document.querySelector(target.selector);
        if (element) {
          selectedText = visibleText(element.textContent);
        }
      }
      if (!selectedText) {
        const candidate = firstCurrencyCandidate();
        selectedText = candidate.valueText;
      }
      observation = {
        valueText: selectedText,
        numericValue: Number.parseFloat((selectedText.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/)?.[1] || '').replace(/,/g, '')) || null,
        selector: target?.selector ?? null
      };
      break;
    }
    case 'text_appears':
    case 'text_disappears': {
      observation = {
        valueText: condition.text,
        present: pageText.toLowerCase().includes(condition.text.toLowerCase())
      };
      break;
    }
    case 'value_changes': {
      let selectedText = '';
      if (target?.selector) {
        const element = document.querySelector(target.selector);
        if (element) {
          selectedText = visibleText(element.textContent);
        }
      }
      if (!selectedText && target?.label) {
        const match = findElementByText(target.label, false);
        selectedText = match.valueText;
      }
      observation = {
        valueText: selectedText || target?.label || '',
        selector: target?.selector ?? null
      };
      break;
    }
    case 'element_appears': {
      let present = false;
      let selectedText = '';
      if (target?.selector) {
        const element = document.querySelector(target.selector);
        present = element !== null;
        if (element) {
          selectedText = visibleText(element.textContent);
        }
      }
      if (!present) {
        const match = findElementByText(condition.text, condition.element === 'button');
        present = match.present;
        selectedText = match.valueText;
      }
      observation = {
        present,
        valueText: selectedText,
        selector: target?.selector ?? null
      };
      break;
    }
    default:
      observation = { valueText: '' };
  }

  return {
    authentication: authState === 'required' ? 'authentication_required' : authState,
    observedAt: new Date().toISOString(),
    url: location.href,
    execution: 'authenticated_browser',
    ...observation
  };
}

function captureDraft(condition) {
  const pageText = visibleText(document.body.innerText);
  const authState = detectAuthStateOnDom();

  let draftResult;
  switch (condition.type) {
    case 'numeric_threshold': {
      const candidate = firstCurrencyCandidate();
      draftResult = {
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
      break;
    }
    case 'text_appears':
    case 'text_disappears':
      draftResult = {
        target: {
          text: condition.text
        },
        initialObservation: {
          valueText: condition.text,
          present: pageText.toLowerCase().includes(condition.text.toLowerCase())
        }
      };
      break;
    case 'value_changes': {
      const match = findElementByText(condition.target, false);
      draftResult = {
        target: {
          selector: match.selector,
          label: condition.target
        },
        initialObservation: {
          valueText: match.valueText || condition.target,
          selector: match.selector
        }
      };
      break;
    }
    case 'element_appears': {
      const match = findElementByText(condition.text, condition.element === 'button');
      draftResult = {
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
      break;
    }
    default:
      draftResult = {
        target: {},
        initialObservation: {
          valueText: ''
        }
      };
  }

  return {
    ...draftResult,
    authentication: authState === 'required' ? 'authentication_required' : authState
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'APPPORT_DETECT_AUTH') {
    try {
      const state = detectAuthStateOnDom();
      const mappedState = state === 'required' ? 'authentication_required' : state;
      sendResponse({ ok: true, data: { state: mappedState } });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (message?.type === 'APPPORT_OBSERVE_PAGE') {
    try {
      const observation = observePage(message.condition, message.target);
      sendResponse({ ok: true, data: observation });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

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
