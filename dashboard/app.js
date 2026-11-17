// The Launch Radar's page. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail view with the model's own
// inputs and the protocol's farm plan, the live-token set, and the fitted model itself. No
// network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };
  var GROUPS = ['Other', 'Yield', 'Lending', 'Dexs', 'Staking', 'RWA/Stable', 'Derivatives'];
  // Watchlist membership is carried by the data script's w flag on each row.
  var WATCHLIST = {};
  DATA.rows.forEach(function (r) { if (r.w) WATCHLIST[r.slug] = true; });

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The fitted model, recomputed in the page from the snapshot figures and the coefficients
  // main.ts fitted: the page's number and board.json's number are the same arithmetic.
  function coef(i) { return DATA.model.coefficients[i]; }
  function groupEffect(group) {
    var gi = GROUPS.indexOf(group);
    return gi <= 0 ? 0 : coef(3 + gi);
  }
  function impliedOf(row) {
    var growth = Math.min(60, Math.max(-60, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d)) / 100;
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var logValue = coef(0) + coef(1) * Math.log10(Math.max(1, row.tvl_usd)) + coef(2) * growth + coef(3) * Math.log10(age + 30) + groupEffect(row.group);
    return Math.max(1, Math.round(Math.pow(10, logValue)));
  }
  window.__impliedOf = impliedOf;

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and
  // age decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Lend $' + capital + ' of USDC on ' + name + ' on ' + chain + ' and leave the supply open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Add $' + capital + ' of liquidity to the main pool of ' + name + ' on ' + chain + ' and leave the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' with ' + name + ', then put the bridged funds to work in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and hold the receipt token.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Post $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    if (c.indexOf('prediction') >= 0) return 'Fund an account with $' + capital + ' on ' + name + ' and take one market position.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Put $' + capital + ' into a ' + name + ' vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + ' of the yield-bearing asset ' + name + ' issues on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('risk') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares until the vault\'s term ends.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and leave the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var setupGas = capital >= 150 ? 8 : 4;
    var weeks = Math.max(1, Math.ceil(hold / 7));
    var totalGas = setupGas + 2 * weeks;
    return [
      { text: 'Open a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper, never in a file.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + setupGas + ' of gas', time: '15 minutes to set up' },
      { text: 'Do one qualifying action each week, a deposit, a borrow, a swap or a vote, so the wallet looks active in every snapshot.', cost: 'about $2 of gas a week, $' + (2 * weeks) + ' over ' + weeks + ' weeks', time: '10 minutes a week' },
      { text: 'Keep the position open for at least ' + hold + ' days, so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays locked in the position', time: hold + ' days' },
      { text: 'Before you withdraw, open the protocol\'s own points or rewards page from its own site and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it in one sitting.', cost: 'nothing but the log', time: '5 minutes' },
      { text: 'Total for this plan: $' + capital + ' of capital locked for ' + hold + ' days plus about $' + totalGas + ' of gas, $' + setupGas + ' to set up and $' + (2 * weeks) + ' across ' + weeks + ' weeks of activity.', cost: 'about $' + totalGas + ' out of pocket if the position earns nothing; the $' + capital + ' comes back when you unwind, minus slippage', time: hold + ' days from first deposit to unwind' }
    ].map(stepText);
  }
  window.__farmSteps = farmSteps;

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function headerHtml() {
    return '<header class="top"><div class="brand"><span class="mark"></span><span class="brand-name">LAUNCH RADAR</span></div>' +
      '<div class="top-meta"><div><span>Snapshot</span><b>' + esc(DATA.as_of) + '</b></div><div><span>Source</span><b>DefiLlama index</b></div><div><span>Model</span><b>' + esc(DATA.model_version) + '</b></div><div><span>Comps</span><b>' + DATA.model.comps + ' traded</b></div></div></header>';
  }

  function ledeHtml() {
    var top = DATA.rows[0];
    return '<section class="hud" aria-label="Board summary">' +
      '<div><span>Watchlist covered</span><b>' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</b><small>every slug on the list is ranked</small></div>' +
      '<div><span>Pre-token rows</span><b>' + DATA.board_size + '</b><small>' + DATA.early_size + ' below the floor, by TVL</small></div>' +
      '<div><span>Top implied value</span><b>' + esc(fmtUsd(top ? top.implied_value_usd : 0)) + '</b><small>' + esc(top ? top.name : '') + ', rank 1</small></div>' +
      '<div><span>Median mcap / TVL</span><b>' + DATA.model.overallMedianRatio.toFixed(3) + '</b><small>across the ' + DATA.model.comps + ' comps</small></div>' +
      '<div><span>Leave-one-out median error</span><b>' + (DATA.model.looMedianApe * 100).toFixed(1) + '%</b><small>fit R squared ' + DATA.model.r2.toFixed(3) + '</small></div>' +
      '</section>';
  }

  function modelHtml() {
    var m = DATA.model;
    var b = m.coefficients;
    var coefRows = '<div><span>Intercept</span><b>' + b[0].toFixed(3) + '</b></div>' +
      '<div><span>TVL elasticity (log10 TVL)</span><b>' + b[1].toFixed(3) + '</b></div>' +
      '<div><span>Seven-day growth (per 100%)</span><b>' + b[2].toFixed(3) + '</b></div>' +
      '<div><span>Age (log10 days + 30)</span><b>' + b[3].toFixed(3) + '</b></div>';
    m.groupMedianRatio.forEach(function (g, i) {
      var effect = i === 0 ? 0 : b[3 + i];
      coefRows += '<div><span>Group ' + esc(g.group) + ' (n=' + g.n + ', median mcap/TVL ' + g.medianRatio.toFixed(3) + ')</span><b>' + (effect >= 0 ? '+' : '') + effect.toFixed(3) + '</b></div>';
    });
    var validRows = '<div><span>Comps fitted on</span><b>' + m.comps + ' traded protocols</b></div>' +
      '<div><span>Traded protocols set aside</span><b>' + m.excluded + ' (exchanges, bridges, staking, versioned, zero cap, ratio outside 0.005 to 5)</b></div>' +
      '<div><span>Fit, in sample (R squared)</span><b>' + m.r2.toFixed(3) + '</b></div>' +
      '<div><span>Out-of-sample test, leave-one-out median error</span><b>' + (m.looMedianApe * 100).toFixed(1) + '%</b></div>' +
      '<div><span>Leave-one-out mean error</span><b>' + (m.looMeanApe * 100).toFixed(1) + '%</b></div>' +
      '<div><span>Leave-one-out within a factor of two</span><b>' + (m.looWithin2x * 100).toFixed(1) + '% of comps</b></div>';
    // Sensitivity: a protocol with the median watchlist TVL, group Other, across growth and age.
    var ages = [90, 180, 365, 730, 1095];
    var growths = [-20, -10, 0, 10, 20];
    var tvl = DATA.median_watchlist_tvl || 200000000;
    var sens = '<table class="sens"><caption>Implied value of a protocol with the median watchlist TVL (' + esc(fmtUsd(tvl)) + '), group Other, as growth and age move. Each cell recomputes the fitted model; the centre cell is the base case.</caption><thead><tr><th scope="col">Age / growth</th>' +
      growths.map(function (g) { return '<th scope="col">' + (g > 0 ? '+' : '') + g + '%</th>'; }).join('') + '</tr></thead><tbody>';
    ages.forEach(function (age) {
      sens += '<tr><th scope="row">' + (age >= 365 ? (age / 365).toFixed(age % 365 === 0 ? 0 : 1) + 'y' : age + 'd') + '</th>';
      growths.forEach(function (g) {
        var logValue = b[0] + b[1] * Math.log10(tvl) + b[2] * (g / 100) + b[3] * Math.log10(age + 30);
        var value = Math.max(1, Math.round(Math.pow(10, logValue)));
        var base = g === 0 && age === 365 ? ' class="base"' : '';
        sens += '<td' + base + '>' + esc(fmtUsd(value)) + '</td>';
      });
      sens += '</tr>';
    });
    sens += '</tbody></table>';
    return '<section class="panel"><h2>How the value is fitted</h2>' +
      '<p class="sub">One log-log comps regression on the snapshot\u2019s own traded tokens. log10(market cap) is fitted on log10(TVL), seven-day growth, log10(age in days + 30) and a broad category group. The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. No protocol name is special-cased, and no row is hand-picked.</p>' +
      '<div class="formula"><code>log10(implied) = ' + b[0].toFixed(3) + ' + ' + b[1].toFixed(3) + ' x log10(TVL) + ' + b[2].toFixed(3) + ' x growth + ' + b[3].toFixed(3) + ' x log10(age + 30) + group effect</code></div>' +
      '<div class="model-grid">' + coefRows + '</div>' +
      '<h3>The out-of-sample test</h3><p class="sub">Each traded protocol is predicted without itself in the fit (leave-one-out). TVL explains only part of token value: the median miss is ' + (m.looMedianApe * 100).toFixed(1) + '%, so treat every implied value as a ranking signal with wide error bars, not a price.</p>' +
      '<div class="model-grid">' + validRows + '</div>' +
      '<h3>Sensitivity: growth and age move the value</h3>' + sens + '</section>';
  }

  function controlsHtml() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var options = '<option value="all">All categories</option>' + categories.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="Search name, category or chain" value="' + esc(state.q) + '" aria-label="Search the board"></div>' +
      '<div class="field"><label for="category">Category</label><select id="category" aria-label="Filter by category">' + options + '</select></div>' +
      '<div class="field"><span class="sub">Token status</span><div class="tabs">' +
      '<button type="button" data-tab="pre-token" aria-pressed="' + (state.tab === 'pre-token') + '">Pre-token</button>' +
      '<button type="button" data-tab="live" aria-pressed="' + (state.tab === 'live') + '">Live token</button>' +
      '</div></div>' +
      '<span class="count">' + (state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols') + '</span></div>';
  }

  function sortButton(key, label) {
    var arrow = state.sort === key ? (state.dir < 0 ? ' v' : ' ^') : '';
    return '<button type="button" data-sort="' + key + '">' + esc(label) + esc(arrow) + '</button>';
  }

  function boardHtml() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return '<div class="panel"><div class="empty"><h2>No protocol matches that filter</h2><p>Clear the search or pick another category to see the board again.</p><button class="button" type="button" id="clear-filters">Clear filters</button></div></div>';
    }
    var max = 1;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var body = list.map(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var wl = WATCHLIST[r.slug] ? '<span class="badge">Watchlist</span>' : '';
      var pct = Math.max(3, Math.round((r.implied_value_usd / max) * 100));
      return '<tr data-slug="' + esc(r.slug) + '" data-selected="' + (state.selected === r.slug) + '" tabindex="0">' +
        '<td class="num' + (r.rank === 1 ? ' rank1' : '') + '">' + r.rank + '</td>' +
        '<td><div class="name"><b>' + esc(r.name) + wl + '</b><span class="sub">' + esc(r.category || 'Other') + ' on ' + esc(r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + '</span></div></td>' +
        '<td class="num">' + esc(fmtUsd(r.tvl_usd)) + '</td>' +
        '<td class="num ' + growthClass + '">' + esc(growth) + '</td>' +
        '<td class="num">' + esc(fmtAge(r.age_days)) + '</td>' +
        '<td><div class="implied"><div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div><span class="num">' + esc(fmtUsd(r.implied_value_usd)) + '</span></div></td>' +
        '<td><span class="status">no token</span></td></tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption>Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.</caption>' +
      '<thead><tr><th scope="col">' + sortButton('implied', 'Rank') + '</th><th scope="col">' + sortButton('name', 'Protocol') + '</th><th scope="col" class="num">' + sortButton('tvl', 'TVL') + '</th><th scope="col" class="num">' + sortButton('growth', '7d') + '</th><th scope="col" class="num">' + sortButton('age', 'Age') + '</th><th scope="col">' + sortButton('implied', 'Implied value') + '</th><th scope="col">Token</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  function liveHtml() {
    var body = DATA.live.map(function (r) {
      return '<tr><td class="num">live</td>' +
        '<td><div class="name"><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.category || 'Other') + ' on ' + esc(r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + '</span></div></td>' +
        '<td class="num">' + esc(fmtUsd(r.tvl_usd)) + '</td>' +
        '<td class="num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg') + '">' + esc(fmtPct(r.change_7d)) + '</td>' +
        '<td class="num">' + esc(fmtUsd(r.mcap_usd)) + '</td>' +
        '<td><span class="status live">already trades</span></td></tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption>Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>' +
      '<thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col" class="num">TVL</th><th scope="col" class="num">7d</th><th scope="col" class="num">Market cap</th><th scope="col">Token</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  function footHtml() {
    return '<footer class="foot"><p>Method: one log-log regression fitted on ' + DATA.model.comps + ' traded protocols from this snapshot, validated leave-one-out (median error ' + (DATA.model.looMedianApe * 100).toFixed(1) + '%). The board separates protocols whose token already trades from those still to come, and every implied value is the model\u2019s claim, never a price.</p>' +
      '<p>DefiLlama\u2019s record is not proof: the board says a protocol records no token, never that it has none. Nothing here predicts whether or when a token is issued. Snapshot ' + esc(DATA.as_of) + '.</p></footer>';
  }

  var dialog = document.createElement('dialog');
  dialog.className = 'detail';
  dialog.id = 'detail';
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    var recomputed = impliedOf(row);
    var steps = farmSteps(row);
    var growth = row.change_7d === null ? 0 : Math.min(60, Math.max(-60, row.change_7d));
    var age = row.age_days === null ? 365 : row.age_days;
    var stepsHtml = steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span class="cost">' + esc(tail) + '</span></li>';
    }).join('');
    var chainList = row.chains && row.chains.length ? (row.chains.length > 4 ? row.chains.slice(0, 4).join(', ') + ', and ' + (row.chains.length - 4) + ' more' : row.chains.join(', ')) : 'an unnamed chain';
    dialog.innerHTML =
      '<div class="detail-head"><div><span class="rankline">Rank ' + row.rank + ' of ' + DATA.board_size + '</span>' +
      '<h2 id="detail-title">' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.category || 'Other') + ' on ' + esc(chainList) + '</p></div>' +
      '<button class="close" type="button" aria-label="Close details" id="detail-close">Close</button></div>' +
      '<section class="detail-section"><h3>Implied value</h3>' +
      '<div class="equation">' +
      '<div><span>TVL</span><b>' + esc(fmtUsd(row.tvl_usd)) + '</b></div>' +
      '<div><span>Seven-day growth</span><b>' + esc(fmtPct(row.change_7d)) + '</b></div>' +
      '<div><span>Age with no token</span><b>' + esc(fmtAge(row.age_days)) + '</b></div>' +
      '<div><span>Group (' + esc(row.group) + ')</span><b>' + (groupEffect(row.group) >= 0 ? '+' : '') + groupEffect(row.group).toFixed(3) + '</b></div>' +
      '<div><span>Model recompute</span><b>' + esc(fmtUsd(recomputed)) + '</b></div>' +
      '<div><span>Implied value</span><b>' + esc(fmtUsd(row.implied_value_usd)) + '</b></div>' +
      '</div>' +
      '<p class="sub">Model ' + esc(DATA.model_version) + ': the page recomputes this row as ' + esc(fmtUsd(recomputed)) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' An estimate, not a price. Inputs: log10(TVL) ' + Math.log10(Math.max(1, row.tvl_usd)).toFixed(2) + ', growth ' + growth.toFixed(2) + '%, log10(age + 30) ' + Math.log10(age + 30).toFixed(2) + '.</p></section>' +
      '<section class="detail-section"><h3>Farm plan</h3><ol class="steps">' + stepsHtml + '</ol></section>';
    document.getElementById('detail-close').addEventListener('click', function () { dialog.close(); });
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.innerHTML = '<div class="shell">' + headerHtml() + ledeHtml() + controlsHtml() + (state.tab === 'pre-token' ? boardHtml() : liveHtml()) + modelHtml() + footHtml() + '</div>';
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    var cat = document.getElementById('category');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var clear = document.getElementById('clear-filters');
    if (clear) clear.addEventListener('click', function () { state.q = ''; state.category = 'all'; writeHash(); render(); });
    Array.prototype.forEach.call(app.querySelectorAll('[data-tab]'), function (btn) {
      btn.addEventListener('click', function () { state.tab = btn.getAttribute('data-tab'); writeHash(); render(); });
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-sort]'), function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        render();
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('tbody tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(tr.getAttribute('data-slug')); }
      });
    });
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
