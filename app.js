/* =========================================================
   TripSplit — app.js
   A personal, offline-friendly trip expense splitter.
   All state lives in localStorage; nothing leaves the device.
   Each traveler can log any number of itemized expenses
   (a note + an amount); totals, balances, and settlements
   are all derived from that list.
   ========================================================= */
(() => {
  'use strict';

  const STORAGE_KEY = 'tripsplit_v1';
  const MIN_TRAVELERS = 2;
  const MAX_TRAVELERS = 20;

  /* ---------------------------------------------------------
     Small DOM helpers
     --------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const uid = () => (
    (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9)
  );

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  function avatarGradient(name) {
    const hue = hashHue(name || 'traveler');
    return `linear-gradient(135deg, hsl(${hue} 68% 56%), hsl(${(hue + 46) % 360} 62% 42%))`;
  }

  function formatMoney(amount, currency, opts = {}) {
    const n = Number(amount) || 0;
    const maxFrac = opts.maxFrac ?? (Number.isInteger(n) ? 0 : 2);
    const formatted = n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: maxFrac });
    return `${currency}${formatted}`;
  }

  /* ---------------------------------------------------------
     State
     person = { id, name, expenses: [{ id, note, amount }] }
     --------------------------------------------------------- */
  let state = null;

  function defaultState() {
    return {
      tripName: '',
      currency: '₹',
      roundSettlements: true,
      people: [], // {id, name, expenses:[{id, note, amount}]}
    };
  }

  function personTotal(person) {
    if (!person || !Array.isArray(person.expenses)) return 0;
    return person.expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.people)) return null;
      // Migrate older single-amount records (pre-itemized-expenses) forward.
      parsed.people.forEach(p => {
        if (!Array.isArray(p.expenses)) {
          const amt = Number(p.amount) || 0;
          p.expenses = amt > 0 ? [{ id: uid(), note: 'Trip expense', amount: amt }] : [];
        }
        delete p.amount;
        p.expenses.forEach(e => {
          if (typeof e.id !== 'string') e.id = uid();
          if (typeof e.note !== 'string') e.note = 'Expense';
        });
      });
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage unavailable (private mode etc.) — app still works in-memory */
    }
  }

  /* ---------------------------------------------------------
     Settlement algorithm (min cash-flow / debt simplification)
     --------------------------------------------------------- */
  function computeSettlement(people, currency, roundWhole) {
    const totals = people.map(p => personTotal(p));
    const total = totals.reduce((s, t) => s + t, 0);
    const n = people.length;
    const fair = n > 0 ? total / n : 0;

    const balances = people.map((p, i) => ({
      id: p.id,
      name: p.name,
      amount: totals[i],
      balance: Math.round((totals[i] - fair) * 100) / 100,
    }));

    const creditors = balances
      .filter(b => b.balance > 0.004)
      .map(b => ({ ...b }))
      .sort((a, b) => b.balance - a.balance);
    const debtors = balances
      .filter(b => b.balance < -0.004)
      .map(b => ({ ...b, owe: -b.balance }))
      .sort((a, b) => b.owe - a.owe);

    const settlements = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const c = creditors[ci];
      const d = debtors[di];
      const raw = Math.min(c.balance, d.owe);
      let amt = Math.round(raw * 100) / 100;
      if (roundWhole) amt = Math.round(amt);
      if (amt > 0.004) {
        settlements.push({ from: d.name, to: c.name, amount: amt });
      }
      c.balance = Math.round((c.balance - raw) * 100) / 100;
      d.owe = Math.round((d.owe - raw) * 100) / 100;
      if (c.balance <= 0.004) ci++;
      if (d.owe <= 0.004) di++;
    }

    return { total, fair, balances, settlements };
  }

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
  }

  /* ---------------------------------------------------------
     Screen switching
     --------------------------------------------------------- */
  function showScreen(name) {
    $('#setup-screen').hidden = name !== 'setup';
    $('#dashboard-screen').hidden = name !== 'dashboard';
  }

  /* ===========================================================
     SETUP SCREEN
     =========================================================== */
  let setupCount = 4;
  let setupNames = [];

  function initSetupScreen() {
    setupCount = 4;
    setupNames = new Array(setupCount).fill('');
    $('#trip-name-input').value = '';
    $('#stepper-value').textContent = String(setupCount);
    renderNameFields();
    showScreen('setup');
  }

  function renderNameFields() {
    const wrap = $('#name-fields');
    wrap.innerHTML = '';
    for (let i = 0; i < setupCount; i++) {
      const row = document.createElement('div');
      row.className = 'name-field-row';
      const label = setupNames[i] || `Traveler ${i + 1}`;
      row.innerHTML = `
        <span class="name-field-row__badge" style="background:${avatarGradient(label)}">${initials(label)}</span>
        <input class="field__input" type="text" maxlength="24" placeholder="Traveler ${i + 1}" autocomplete="off" />
      `;
      const input = row.querySelector('input');
      input.value = setupNames[i] || '';
      input.addEventListener('input', () => {
        setupNames[i] = input.value;
        const badge = row.querySelector('.name-field-row__badge');
        const nm = input.value || `Traveler ${i + 1}`;
        badge.style.background = avatarGradient(nm);
        badge.textContent = initials(nm);
      });
      wrap.appendChild(row);
    }
  }

  function changeStepper(delta) {
    const next = setupCount + delta;
    if (next < MIN_TRAVELERS || next > MAX_TRAVELERS) return;
    setupCount = next;
    setupNames.length = setupCount;
    for (let i = 0; i < setupCount; i++) if (setupNames[i] == null) setupNames[i] = '';
    $('#stepper-value').textContent = String(setupCount);
    renderNameFields();
  }

  function handleSetupSubmit(e) {
    e.preventDefault();
    const tripName = $('#trip-name-input').value.trim() || 'Our Trip';
    const people = [];
    for (let i = 0; i < setupCount; i++) {
      const name = (setupNames[i] || '').trim() || `Traveler ${i + 1}`;
      people.push({ id: uid(), name, expenses: [] });
    }
    state = defaultState();
    state.tripName = tripName;
    state.people = people;
    saveState();
    showScreen('dashboard');
    renderDashboard();
  }

  /* ===========================================================
     DASHBOARD SCREEN
     =========================================================== */
  function renderDashboard() {
    $('#trip-name-display').value = state.tripName;
    renderCurrencyPicker();
    $('#round-toggle').checked = !!state.roundSettlements;
    renderCardsGrid();
    updateComputed();
  }

  function renderCurrencyPicker() {
    $$('.currency-picker__opt').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.currency === state.currency);
    });
  }

  function renderCardsGrid() {
    const grid = $('#cards-grid');
    grid.innerHTML = '';
    const cardTpl = $('#card-template');
    const addTpl = $('#add-card-template');

    state.people.forEach(person => {
      const node = cardTpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = person.id;

      const avatar = $('.card__avatar', node);
      avatar.style.background = avatarGradient(person.name);
      avatar.textContent = initials(person.name);

      $('.card__name', node).textContent = person.name;
      $('.card__back-name', node).textContent = person.name;
      $('.card__currency', node).textContent = state.currency;
      $('.card__total-figure', node).textContent = formatMoney(personTotal(person), '', { maxFrac: 2 }).trim();
      updateExpenseHint(node, person);

      // Front tap reveals the total. Once revealed, tapping again opens the
      // expense manager (flipping back to front is done via the small arrow
      // button on the back, which stops propagation before this fires).
      node.addEventListener('click', () => {
        if (node.classList.contains('is-flipped')) {
          openExpenseSheet(person.id);
        } else {
          node.classList.add('is-flipped');
        }
      });
      node.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === node) {
          e.preventDefault();
          if (node.classList.contains('is-flipped')) openExpenseSheet(person.id);
          else node.classList.add('is-flipped');
        }
      });

      $('.card__back-btn', node).addEventListener('click', (e) => {
        e.stopPropagation();
        node.classList.remove('is-flipped');
      });

      $$('.card__menu-btn', node).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openRenameModal(person.id);
        });
      });

      grid.appendChild(node);
    });

    const addNode = addTpl.content.firstElementChild.cloneNode(true);
    addNode.addEventListener('click', addPerson);
    grid.appendChild(addNode);
  }

  function updateExpenseHint(cardNode, person) {
    const count = (person.expenses || []).length;
    const hint = $('.card__expense-hint', cardNode);
    if (!hint) return;
    hint.textContent = count === 0
      ? 'No expenses yet · tap to add'
      : `${count} expense${count === 1 ? '' : 's'} · tap to edit`;
  }

  /* --- computed values: total, per-card balances, settlement list ---
     Cards never hold an editable input anymore (that lives in the expense
     sheet), so it's always safe to refresh their text in place. */
  function updateComputed() {
    const { total, fair, balances, settlements } = computeSettlement(
      state.people, state.currency, state.roundSettlements
    );

    const figureEl = $('#total-figure');
    const newFigure = formatMoney(total, '', { maxFrac: 2 }).trim();
    if (figureEl.textContent !== newFigure) {
      figureEl.textContent = newFigure;
      figureEl.classList.remove('is-pulsing');
      void figureEl.offsetWidth; // reflow to restart animation
      figureEl.classList.add('is-pulsing');
    }
    $('#total-currency').textContent = state.currency;

    const n = state.people.length;
    $('#total-sub').innerHTML = n > 0
      ? `${n} traveler${n === 1 ? '' : 's'} · <span class="mono">${formatMoney(fair, state.currency)}</span> avg / person`
      : 'Add travelers to get started';

    balances.forEach(b => {
      const card = $(`.card[data-id="${b.id}"]`);
      if (!card) return;
      const person = state.people.find(p => p.id === b.id);

      $('.card__currency', card).textContent = state.currency;
      $('.card__total-figure', card).textContent = formatMoney(b.amount, '', { maxFrac: 2 }).trim();
      if (person) updateExpenseHint(card, person);

      const badge = $('.card__balance', card);
      if (Math.abs(b.balance) < 0.005 && total > 0) {
        badge.textContent = 'Settled up';
        badge.className = 'card__balance is-even';
      } else if (b.balance > 0) {
        badge.textContent = `Gets back ${formatMoney(b.balance, state.currency)}`;
        badge.className = 'card__balance is-owed';
      } else if (b.balance < 0) {
        badge.textContent = `Owes ${formatMoney(-b.balance, state.currency)}`;
        badge.className = 'card__balance is-owes';
      } else {
        badge.textContent = '';
        badge.className = 'card__balance';
      }
    });

    renderSettleList(settlements, total);

    // Keep an open expense sheet's own total in sync (e.g. after a currency change).
    if (expenseTargetId) updateExpenseSheetTotal();
  }

  function renderSettleList(settlements, total) {
    const list = $('#settle-list');
    list.innerHTML = '';

    if (total <= 0) {
      const empty = document.createElement('div');
      empty.className = 'settle-empty';
      empty.innerHTML = `<strong>Nothing yet</strong>Flip a card and log what each traveler spent to see who owes what.`;
      list.appendChild(empty);
      return;
    }

    if (settlements.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settle-empty';
      empty.innerHTML = `<strong>All settled up 🎉</strong>Everyone paid their fair share.`;
      list.appendChild(empty);
      return;
    }

    const tpl = $('#settle-row-template');
    settlements.forEach(s => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      $('.settle-row__from', row).textContent = s.from;
      $('.settle-row__to', row).textContent = s.to;
      $('.settle-row__amount', row).textContent = formatMoney(s.amount, state.currency);
      list.appendChild(row);
    });
  }

  /* --- add / rename / remove people --- */
  function addPerson() {
    if (state.people.length >= MAX_TRAVELERS) {
      toast(`Keep it to ${MAX_TRAVELERS} travelers or fewer`);
      return;
    }
    const n = state.people.length + 1;
    const person = { id: uid(), name: `Traveler ${n}`, expenses: [] };
    state.people.push(person);
    saveState();
    renderCardsGrid();
    updateComputed();
    openRenameModal(person.id, { isNew: true });
  }

  let renameTargetId = null;
  function openRenameModal(personId, opts = {}) {
    const person = state.people.find(p => p.id === personId);
    if (!person) return;
    renameTargetId = personId;
    $('#rename-input').value = opts.isNew ? '' : person.name;
    $('#rename-modal').hidden = false;
    $('#modal-backdrop').hidden = false;
    requestAnimationFrame(() => {
      $('#modal-backdrop').classList.add('is-visible');
      $('#rename-modal').classList.add('is-visible');
    });
    setTimeout(() => {
      const input = $('#rename-input');
      input.focus();
      input.select();
    }, 60);
  }

  function closeRenameModal() {
    $('#modal-backdrop').classList.remove('is-visible');
    $('#rename-modal').classList.remove('is-visible');
    setTimeout(() => {
      $('#rename-modal').hidden = true;
      $('#modal-backdrop').hidden = true;
    }, 200);
    renameTargetId = null;
  }

  function saveRename() {
    const person = state.people.find(p => p.id === renameTargetId);
    if (!person) { closeRenameModal(); return; }
    const val = $('#rename-input').value.trim();
    person.name = val || person.name || 'Traveler';
    saveState();
    renderCardsGrid();
    updateComputed();
    closeRenameModal();
  }

  function deletePerson() {
    const person = state.people.find(p => p.id === renameTargetId);
    if (!person) { closeRenameModal(); return; }
    if (state.people.length <= 1) {
      toast('A trip needs at least one traveler');
      return;
    }
    if (!confirm(`Remove ${person.name} from this trip? Their logged expenses will be removed too.`)) return;
    state.people = state.people.filter(p => p.id !== renameTargetId);
    saveState();
    renderCardsGrid();
    updateComputed();
    closeRenameModal();
  }

  /* ===========================================================
     EXPENSE SHEET — add / edit / delete a person's itemized spends
     =========================================================== */
  let expenseTargetId = null;

  function openExpenseSheet(personId) {
    const person = state.people.find(p => p.id === personId);
    if (!person) return;
    expenseTargetId = personId;

    $('#expense-sheet-name').textContent = person.name;
    $('#expense-add-currency').textContent = state.currency;
    $('#expense-note-input').value = '';
    $('#expense-amount-input').value = '';
    renderExpenseList();
    updateExpenseSheetTotal();

    $('#expense-sheet').hidden = false;
    $('#expense-backdrop').hidden = false;
    requestAnimationFrame(() => {
      $('#expense-backdrop').classList.add('is-visible');
      $('#expense-sheet').classList.add('is-visible');
    });
    setTimeout(() => $('#expense-note-input').focus(), 260);
  }

  function closeExpenseSheet() {
    $('#expense-backdrop').classList.remove('is-visible');
    $('#expense-sheet').classList.remove('is-visible');
    setTimeout(() => {
      $('#expense-sheet').hidden = true;
      $('#expense-backdrop').hidden = true;
    }, 260);
    expenseTargetId = null;
    // Card text (totals, expense counts) may have changed while the sheet was open.
    renderCardsGrid();
    updateComputed();
  }

  function currentExpensePerson() {
    return state.people.find(p => p.id === expenseTargetId) || null;
  }

  function renderExpenseList() {
    const person = currentExpensePerson();
    const list = $('#expense-list');
    const empty = $('#expense-empty');
    list.innerHTML = '';
    if (!person || person.expenses.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const tpl = $('#expense-row-template');
    person.expenses.forEach(exp => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.expId = exp.id;
      const noteInput = $('.expense-row__note', row);
      const amtInput = $('.expense-row__amount', row);

      noteInput.value = exp.note || '';
      amtInput.value = exp.amount ? String(exp.amount) : '';
      $('.expense-row__currency', row).textContent = state.currency;

      noteInput.addEventListener('input', () => {
        exp.note = noteInput.value;
        saveState();
      });
      noteInput.addEventListener('blur', () => {
        if (!noteInput.value.trim()) {
          exp.note = 'Expense';
          noteInput.value = exp.note;
          saveState();
        }
      });

      amtInput.addEventListener('input', () => {
        const val = parseFloat(amtInput.value);
        exp.amount = isNaN(val) ? 0 : val;
        saveState();
        updateExpenseSheetTotal();
        updateComputed();
      });
      amtInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') amtInput.blur();
      });

      $('.expense-row__delete', row).addEventListener('click', () => {
        person.expenses = person.expenses.filter(x => x.id !== exp.id);
        saveState();
        renderExpenseList();
        updateExpenseSheetTotal();
        updateComputed();
      });

      list.appendChild(row);
    });
  }

  function updateExpenseSheetTotal() {
    const person = currentExpensePerson();
    if (!person) return;
    $('#expense-sheet-total').textContent = formatMoney(personTotal(person), state.currency);
  }

  function handleAddExpense(e) {
    e.preventDefault();
    const person = currentExpensePerson();
    if (!person) return;

    const note = $('#expense-note-input').value.trim() || 'Expense';
    const amtVal = parseFloat($('#expense-amount-input').value);
    if (isNaN(amtVal) || amtVal <= 0) {
      toast('Enter an amount for this expense');
      $('#expense-amount-input').focus();
      return;
    }

    person.expenses.push({ id: uid(), note, amount: amtVal });
    saveState();
    renderExpenseList();
    updateExpenseSheetTotal();
    updateComputed();

    $('#expense-note-input').value = '';
    $('#expense-amount-input').value = '';
    $('#expense-note-input').focus();
  }

  /* ===========================================================
     TRIP SUMMARY SHEET
     =========================================================== */
  function openSummarySheet() {
    renderSummaryBody();
    $('#summary-trip-name').textContent = `${state.tripName} — summary`;
    const { total, fair } = computeSettlement(state.people, state.currency, state.roundSettlements);
    const n = state.people.length;
    $('#summary-total-line').innerHTML = n > 0
      ? `Total <span class="mono">${formatMoney(total, state.currency)}</span> across ${n} traveler${n === 1 ? '' : 's'} · <span class="mono">${formatMoney(fair, state.currency)}</span> avg`
      : '';

    $('#summary-sheet').hidden = false;
    $('#summary-backdrop').hidden = false;
    requestAnimationFrame(() => {
      $('#summary-backdrop').classList.add('is-visible');
      $('#summary-sheet').classList.add('is-visible');
    });
  }

  function closeSummarySheet() {
    $('#summary-backdrop').classList.remove('is-visible');
    $('#summary-sheet').classList.remove('is-visible');
    setTimeout(() => {
      $('#summary-sheet').hidden = true;
      $('#summary-backdrop').hidden = true;
    }, 260);
  }

  function renderSummaryBody() {
    const body = $('#summary-body');
    body.innerHTML = '';

    const peopleLabel = document.createElement('p');
    peopleLabel.className = 'summary-section-label';
    peopleLabel.textContent = 'Travelers';
    body.appendChild(peopleLabel);

    const personTpl = $('#summary-person-template');
    const itemTpl = $('#summary-item-template');
    const emptyTpl = $('#summary-empty-items-template');

    state.people.forEach(p => {
      const node = personTpl.content.firstElementChild.cloneNode(true);
      const avatarEl = $('.summary-person__avatar', node);
      avatarEl.style.background = avatarGradient(p.name);
      avatarEl.textContent = initials(p.name);
      $('.summary-person__name', node).textContent = p.name;
      $('.summary-person__total', node).textContent = formatMoney(personTotal(p), state.currency);

      const itemsWrap = $('.summary-person__items', node);
      if (!p.expenses || p.expenses.length === 0) {
        itemsWrap.appendChild(emptyTpl.content.firstElementChild.cloneNode(true));
      } else {
        p.expenses.forEach(exp => {
          const item = itemTpl.content.firstElementChild.cloneNode(true);
          $('.summary-item__note', item).textContent = exp.note || 'Expense';
          $('.summary-item__amount', item).textContent = formatMoney(exp.amount, state.currency);
          itemsWrap.appendChild(item);
        });
      }
      body.appendChild(node);
    });

    const settleLabel = document.createElement('p');
    settleLabel.className = 'summary-section-label';
    settleLabel.textContent = 'Who owes whom';
    body.appendChild(settleLabel);

    const { settlements, total } = computeSettlement(state.people, state.currency, state.roundSettlements);
    const settleWrap = document.createElement('div');
    settleWrap.className = 'summary-settle-wrap';

    if (total <= 0) {
      const p2 = document.createElement('p');
      p2.className = 'summary-person__empty';
      p2.textContent = 'Add some expenses to see settlements here.';
      settleWrap.appendChild(p2);
    } else if (settlements.length === 0) {
      const p2 = document.createElement('p');
      p2.className = 'summary-person__empty';
      p2.textContent = 'Everyone is settled up 🎉';
      settleWrap.appendChild(p2);
    } else {
      const rowTpl = $('#settle-row-template');
      settlements.forEach(s => {
        const row = rowTpl.content.firstElementChild.cloneNode(true);
        $('.settle-row__from', row).textContent = s.from;
        $('.settle-row__to', row).textContent = s.to;
        $('.settle-row__amount', row).textContent = formatMoney(s.amount, state.currency);
        settleWrap.appendChild(row);
      });
    }
    body.appendChild(settleWrap);
  }

  /* --- settings sheet --- */
  function openSheet() {
    $('#settings-sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
    requestAnimationFrame(() => {
      $('#sheet-backdrop').classList.add('is-visible');
      $('#settings-sheet').classList.add('is-visible');
    });
  }
  function closeSheet() {
    $('#sheet-backdrop').classList.remove('is-visible');
    $('#settings-sheet').classList.remove('is-visible');
    setTimeout(() => {
      $('#settings-sheet').hidden = true;
      $('#sheet-backdrop').hidden = true;
    }, 260);
  }

  function setCurrency(sym) {
    state.currency = sym;
    saveState();
    renderCurrencyPicker();
    updateComputed();
  }

  function startNewTrip() {
    if (!confirm('This clears everyone and every expense, and starts a fresh trip. Continue?')) return;
    localStorage.removeItem(STORAGE_KEY);
    closeSheet();
    initSetupScreen();
  }

  function resetExpenses() {
    if (!confirm('Clear every logged expense for this trip? Travelers stay, but their expenses can\u2019t be recovered.')) return;
    state.people.forEach(p => p.expenses = []);
    saveState();
    renderCardsGrid();
    updateComputed();
    toast('Expenses reset');
  }

  /* --- share / summary text --- */
  function buildSummaryText() {
    const { total, fair, settlements } = computeSettlement(state.people, state.currency, state.roundSettlements);
    const lines = [];
    lines.push(`\u{1F9F3} ${state.tripName} — trip summary`);
    lines.push(`Total spend: ${formatMoney(total, state.currency)} across ${state.people.length} traveler${state.people.length === 1 ? '' : 's'} (avg ${formatMoney(fair, state.currency)}/person)`);
    lines.push('');
    state.people.forEach(p => {
      lines.push(`${p.name} — ${formatMoney(personTotal(p), state.currency)}`);
      (p.expenses || []).forEach(exp => {
        lines.push(`   • ${exp.note || 'Expense'}: ${formatMoney(exp.amount, state.currency)}`);
      });
    });
    lines.push('');
    if (settlements.length === 0) {
      lines.push('Everyone is settled up — nothing to pay!');
    } else {
      lines.push('Who owes whom:');
      settlements.forEach(s => lines.push(`${s.from} owes ${s.to} ${formatMoney(s.amount, state.currency)}`));
    }
    lines.push('');
    lines.push('— split with TripSplit');
    return lines.join('\n');
  }

  async function shareSummary() {
    const text = buildSummaryText();
    try {
      if (navigator.share) {
        await navigator.share({ text, title: state.tripName });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast('Summary copied to clipboard');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('Summary copied to clipboard');
      } catch (e2) {
        toast('Could not copy — try again');
      }
    }
  }

  /* ---------------------------------------------------------
     Wire up static controls
     --------------------------------------------------------- */
  function bindEvents() {
    $('#stepper-minus').addEventListener('click', () => changeStepper(-1));
    $('#stepper-plus').addEventListener('click', () => changeStepper(1));
    $('#setup-form').addEventListener('submit', handleSetupSubmit);

    $('#trip-name-display').addEventListener('input', (e) => {
      state.tripName = e.target.value;
      saveState();
    });
    $('#trip-name-display').addEventListener('blur', () => {
      if (!state.tripName.trim()) {
        state.tripName = 'Our Trip';
        $('#trip-name-display').value = state.tripName;
        saveState();
      }
    });

    $('#settings-btn').addEventListener('click', openSheet);
    $('#sheet-close-btn').addEventListener('click', closeSheet);
    $('#sheet-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#sheet-backdrop')) closeSheet();
    });
    $('#new-trip-btn').addEventListener('click', startNewTrip);
    $('#round-toggle').addEventListener('change', (e) => {
      state.roundSettlements = e.target.checked;
      saveState();
      updateComputed();
    });
    $$('.currency-picker__opt').forEach(btn => {
      btn.addEventListener('click', () => setCurrency(btn.dataset.currency));
    });

    $('#rename-save-btn').addEventListener('click', saveRename);
    $('#rename-cancel-btn').addEventListener('click', closeRenameModal);
    $('#rename-delete-btn').addEventListener('click', deletePerson);
    $('#rename-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveRename();
      if (e.key === 'Escape') closeRenameModal();
    });
    $('#modal-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#modal-backdrop')) closeRenameModal();
    });

    $('#expense-add-form').addEventListener('submit', handleAddExpense);
    $('#expense-sheet-done').addEventListener('click', closeExpenseSheet);
    $('#expense-sheet-close-x').addEventListener('click', closeExpenseSheet);
    $('#expense-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#expense-backdrop')) closeExpenseSheet();
    });

    $('#summary-btn').addEventListener('click', openSummarySheet);
    $('#summary-close-btn').addEventListener('click', closeSummarySheet);
    $('#summary-share-btn').addEventListener('click', shareSummary);
    $('#summary-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#summary-backdrop')) closeSummarySheet();
    });

    $('#reset-btn').addEventListener('click', resetExpenses);
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  function boot() {
    bindEvents();
    const loaded = loadState();
    if (loaded && loaded.people && loaded.people.length > 0) {
      state = Object.assign(defaultState(), loaded);
      showScreen('dashboard');
      renderDashboard();
    } else {
      initSetupScreen();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  /* ---------------------------------------------------------
     Service worker registration (safe no-op if unsupported)
     --------------------------------------------------------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }
})();
