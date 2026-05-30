'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require uci';
'require tools.widgets as widgets';

const callGetStatus = rpc.declare({ object: 'tailscale', method: 'get_status' });
const callGetSettings = rpc.declare({ object: 'tailscale', method: 'get_settings' });
const callDoLogin = rpc.declare({ object: 'tailscale', method: 'do_login', params: ['form_data'] });
const callDoLogout = rpc.declare({ object: 'tailscale', method: 'do_logout' });
const callGetSubroutes = rpc.declare({ object: 'tailscale', method: 'get_subroutes' });
const callSetupFirewall = rpc.declare({ object: 'tailscale', method: 'setup_firewall' });
const callGetLogs = rpc.declare({ object: 'tailscale', method: 'get_logs', params: ['lines'] });
const callPing = rpc.declare({ object: 'tailscale', method: 'ping', params: ['target'] });
const callTraceroute = rpc.declare({ object: 'tailscale', method: 'traceroute', params: ['target'] });
let map;

const tailscaleSettingsConf = [
	[form.Flag, 'service_enabled', _('Enable Tailscale Service'), _('Enable or disable the Tailscale service. When disabled, the service will be stopped and the process will be killed.'), { rmempty: false }],
	[form.ListValue, 'fw_mode', _('Firewall Mode'), _('Select the firewall backend for Tailscale to use. Requires service restart to take effect.'), {values: ['nftables','iptables'],rmempty: false}],
	[form.Flag, 'accept_routes', _('Accept Routes'), _('Allow accepting routes announced by other nodes.'), { rmempty: false }],
	[form.Flag, 'advertise_exit_node', _('Advertise Exit Node'), _('Declare this device as an Exit Node.'), { rmempty: false }],
	[form.Flag, 'exit_node_allow_lan_access', _('Allow LAN Access'), _('When using the exit node, access to the local LAN is allowed.'), { rmempty: false }],
	[form.Flag, 'runwebclient', _('Enable Web Interface'), _('Expose a web interface on port 5252 for managing this node over Tailscale.'), { rmempty: false }],
	[form.Flag, 'nosnat', _('Disable SNAT'), _('Disable Source NAT (SNAT) for traffic to advertised routes. Most users should leave this unchecked.'), { rmempty: false }],
	[form.Flag, 'shields_up', _('Shields Up'), _('When enabled, blocks all inbound connections from the Tailscale network.'), { rmempty: false }],
	[form.Flag, 'ssh', _('Enable Tailscale SSH'), _('Allow connecting to this device through the SSH function of Tailscale.'), { rmempty: false }],
	[form.ListValue, 'dns_mode', _('DNS Mode'), _('Controls how Tailscale DNS is handled.')+'<br>'+_('Disabled: system DNS only.')+'<br>'+_('MagicDNS: Tailscale overrides resolv.conf.')+'<br>'+_('OpenWrt Forward: MagicDNS via dnsmasq forwarding.(Only support ts.net)'), { values: [['disabled', _('Disabled')], ['magicdns', 'MagicDNS'], ['openwrt_forward', _('OpenWrt Forward')]], rmempty: false }],
	[form.Flag, 'enable_relay', _('Enable Peer Relay'), _('Enable this device as a Peer Relay server. Requires a public IP and an UDP port open on the router.'), { rmempty: false }],
	[form.Value, 'hostname', _('Custom Hostname'), _('Set a custom hostname for this device on the Tailscale network. Leave blank to use the system hostname.'), { rmempty: true }]
];

const accountConf = [];	// dynamic created in render function

const daemonConf = [
	//[form.Value, 'daemon_mtu', _('Daemon MTU'), _('Set a custom MTU for the Tailscale daemon. Leave blank to use the default value.'), { datatype: 'uinteger', placeholder: '1280' }, { rmempty: false }],
	[form.Flag, 'daemon_reduce_memory', _('(Experimental) Reduce Memory Usage'), _('Enabling this option can reduce memory usage, but it may sacrifice some performance (set GOGC=10).'), { rmempty: false }]
];

const derpMapUrl = 'https://controlplane.tailscale.com/derpmap/default';
// Inlined DERP region table. Used as the default so the UI works offline and
// in restricted networks where controlplane.tailscale.com is unreachable.
// Refreshed asynchronously from the network when available.
const defaultRegionMap = {
	'nyc': 'New York City',
	'sfo': 'San Francisco',
	'sea': 'Seattle',
	'lax': 'Los Angeles',
	'chi': 'Chicago',
	'den': 'Denver',
	'dfw': 'Dallas',
	'mia': 'Miami',
	'tor': 'Toronto',
	'lhr': 'London',
	'fra': 'Frankfurt',
	'ams': 'Amsterdam',
	'par': 'Paris',
	'mad': 'Madrid',
	'waw': 'Warsaw',
	'sto': 'Stockholm',
	'hel': 'Helsinki',
	'dub': 'Dublin',
	'ist': 'Istanbul',
	'tyo': 'Tokyo',
	'sin': 'Singapore',
	'syd': 'Sydney',
	'hkg': 'Hong Kong',
	'sao': 'São Paulo',
	'blr': 'Bangalore',
	'jnb': 'Johannesburg',
	'dxb': 'Dubai',
	'nrt': 'Tokyo',
	'icn': 'Seoul',
	'bom': 'Mumbai'
};
let regionCodeMap = Object.assign({}, defaultRegionMap);
// Kick off a single async refresh from the network on module load.
// The inlined defaults remain available immediately and the merged result
// (defaults + fetched) replaces regionCodeMap when the request resolves.
initializeRegionMap();

// this function copy from luci-app-frpc. thx
function setParams(o, params) {
	if (!params) return;

	for (const [key, val] of Object.entries(params)) {
		if (key === 'values') {
			[].concat(val).forEach(v =>
				o.value.apply(o, Array.isArray(v) ? v : [v])
			);
		} else if (key === 'depends') {
			const arr = Array.isArray(val) ? val : [val];
			o.deps = arr.map(dep => Object.assign({}, ...o.deps, dep));
		} else {
			o[key] = val;
		}
	}

	if (params.datatype === 'bool')
		Object.assign(o, { enabled: 'true', disabled: 'false' });
}

// this function copy from luci-app-frpc. thx
function defTabOpts(s, t, opts, params) {
	for (let i = 0; i < opts.length; i++) {
		const opt = opts[i];
		const o = s.taboption(t, opt[0], opt[1], opt[2], opt[3]);
		setParams(o, opt[4]);
		setParams(o, params);
	}
}

function getRunningStatus() {
	return L.resolveDefault(callGetStatus(), { running: false }).then(function (res) {
		return res;
	});
}

function formatBytes(bytes) {
	const bytes_num = parseInt(bytes, 10);
	if (isNaN(bytes_num) || bytes_num === 0) return '-';
	const k = 1024;
	const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes_num) / Math.log(k)));
	return parseFloat((bytes_num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatLastSeen(d) {
	if (!d) return _('N/A');
	if (d === '0001-01-01T00:00:00Z') return _('Now');
	const t = new Date(d);
	if (isNaN(t)) return _('Invalid Date');
	const diff = (Date.now() - t) / 1000;
	if (diff < 0) return t.toLocaleString();
	if (diff < 60) return _('Just now');

	const mins = diff / 60, hrs = mins / 60, days = hrs / 24;
	const fmt = (n, s, p) => `${Math.floor(n)} ${Math.floor(n) === 1 ? _(s) : _(p)} ${_('ago')}`;

	if (mins < 60) return fmt(mins, 'minute', 'minutes');
	if (hrs < 24) return fmt(hrs, 'hour', 'hours');
	if (days < 30) return fmt(days, 'day', 'days');

	return t.toISOString().slice(0, 10);
}

async function initializeRegionMap() {
	const cacheKey = 'tailscale_derp_map_cache';
	const ttl = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

	try {
		const cachedItem = localStorage.getItem(cacheKey);
		if (cachedItem) {
			const cached = JSON.parse(cachedItem);
			if (Date.now() - cached.timestamp < ttl) {
				regionCodeMap = Object.assign({}, defaultRegionMap, cached.data);
				return;
			}
		}
	} catch (e) {
		// Ignore cache errors and continue with the inlined defaults.
	}

	// Try to refresh from the network in the background. Failures are silent
	// because the inlined defaultRegionMap already provides reasonable coverage.
	try {
		const response = await fetch(derpMapUrl);
		if (!response.ok) return;
		const data = await response.json();
		const newRegionMap = {};
		for (const regionId in data.Regions) {
			const region = data.Regions[regionId];
			const code = (region.RegionCode || '').toLowerCase();
			const name = region.RegionName || region.RegionCode || `Region ${regionId}`;
			if (code) newRegionMap[code] = name;
		}
		regionCodeMap = Object.assign({}, defaultRegionMap, newRegionMap);

		try {
			localStorage.setItem(cacheKey, JSON.stringify({
				timestamp: Date.now(),
				data: newRegionMap
			}));
		} catch (e) {
			// localStorage may be unavailable (private mode, quota); ignore.
		}
	} catch (error) {
		// Network unreachable — keep using defaultRegionMap silently.
	}
}

function formatConnectionInfo(info) {
	if (!info) { return '-'; }
	if (typeof info === 'string' && info.length === 3) {
		const lowerCaseInfo = info.toLowerCase();
		return regionCodeMap[lowerCaseInfo] || info;
	}
	return info;
}

function renderStatus(status) {
	// If status object is not yet available, show a loading message.
	if (!status || !status.hasOwnProperty('status')) {
		return E('em', {}, _('Collecting data ...'));
	}

	const notificationId = 'tailscale_health_notification';
	let notificationElement = document.getElementById(notificationId);
	if (status.health != '') {
		const message = _('Tailscale Health Check: %s').format(status.health);
		if (notificationElement) {
			notificationElement.textContent = message;
		}
		else {
			let newNotificationContent = E('p', { 'id': notificationId }, message);
			ui.addNotification(null, newNotificationContent, 'info');
		}
	}else{
		try{
			notificationElement.parentNode.parentNode.remove();
		}catch(e){}
	}

	// --- Part 1: Handle non-running states ---

	// State: Tailscale binary not found.
	if (status.status == 'not_installed') {
		return E('dl', { 'class': 'cbi-value' }, [
			E('dt', {}, _('Service Status')),
			E('dd', {}, [
				E('span', { 'style': 'color:red;' }, E('strong', {}, _('TAILSCALE NOT FOUND'))),
				E('br'),
				E('span', {}, _('Tailscale is not installed. You can install it using one of the following methods:')),
				E('br'),
				E('pre', { 'style': 'background:#f6f8fa;padding:12px;border-radius:6px;margin-top:8px;font-size:13px;' }, 
					'# Method 1: Install via opkg (OpenWrt official)\nopkg update && opkg install tailscale\n\n# Method 2: Install via opkg (Recommended, smaller size)\n# Add GuNanOvO repo first:\nwget https://GuNanOvO.github.io/openwrt-tailscale/key-build.pub -O /tmp/key-build.pub\nopkg-key add /tmp/key-build.pub\necho "src/gz tailscale https://GuNanOvO.github.io/openwrt-tailscale/packages/$(uname -m)" >> /etc/opkg/customfeeds.conf\nopkg update && opkg install tailscale\n\n# Method 3: Manual binary install\n# Download from https://pkgs.tailscale.com/stable/')
			])
		]);
	}

	// State: Logged out, requires user action.
	if (status.status == 'logout') {
		return E('dl', { 'class': 'cbi-value' }, [
			E('dt', {}, _('Service Status')),
			E('dd', {}, [
				E('span', { 'style': 'color:orange;' }, E('strong', {}, _('LOGGED OUT'))),
				E('br'),
				E('span', {}, _('Please use the login button in the settings below to authenticate.'))
			])
		]);
	}

	// State: Service is installed but not running.
	if (status.status != 'running') {
		return E('dl', { 'class': 'cbi-value' }, [
			E('dt', {}, _('Service Status')),
			E('dd', {}, E('span', { 'style': 'color:red;' }, E('strong', {}, _('NOT RUNNING'))))
		]);
	}

	// --- Part 2: Render the full status display for a running service ---

	// A helper array to define the data for the main status table.
	const statusData = [
		{ label: _('Service Status'), value: E('span', { 'style': 'color:green;' }, E('strong', {}, _('RUNNING'))) },
		{ label: _('Version'), value: status.version || 'N/A' },
		{ label: _('TUN Mode'), value: status.TUNMode ? _('Enabled') : _('Disabled') },
		{ label: _('Tailscale IPv4'), value: status.ipv4 || 'N/A' },
		{ label: _('Tailscale IPv6'), value: status.ipv6 || 'N/A' },
		{ label: _('Tailnet Name'), value: status.domain_name || 'N/A' }
	];

	// Build the horizontal status table using the data array.
	const statusTable = E('table', { 'style': 'width: 100%; border-spacing: 0 5px;' }, [
		E('tr', {}, statusData.map(item => E('td', { 'style': 'padding-right: 20px;' }, E('strong', {}, item.label)))),
		E('tr', {}, statusData.map(item => E('td', { 'style': 'padding-right: 20px;' }, item.value)))
	]);

	return statusTable;
}

function renderDevices(status) {
	if (!status || !status.hasOwnProperty('status')) {
		return E('em', {}, _('Collecting data ...'));
	}

	if (status.status != 'running') {
		return E('em', {}, _('Tailscale status error'));
	}

	const peers = status.peers;
	if (!peers || Object.keys(peers).length === 0) {
		return E('p', {}, _('No peer devices found.'));
	}

	// Sort state
	let sortField = 'hostname';
	let sortAsc = true;

	const peerTableHeaders = [
		{ text: _('Status'), field: 'status', style: 'width: 80px;' },
		{ text: _('Hostname'), field: 'hostname' },
		{ text: _('Tailscale IP'), field: 'ip' },
		{ text: _('OS'), field: 'ostype' },
		{ text: _('Connection Info'), field: 'linkadress' },
		{ text: _('RX'), field: 'rx' },
		{ text: _('TX'), field: 'tx' },
		{ text: _('Last Seen'), field: 'lastseen' }
	];

	// Container for the table
	const container = E('div');

	function getSortedPeers() {
		let entries = Object.entries(peers);
		entries.sort(([, a], [, b]) => {
			let valA, valB;
			switch (sortField) {
				case 'status':
					valA = a.online ? 1 : 0;
					valB = b.online ? 1 : 0;
					break;
				case 'hostname':
					valA = (a.hostname || '').toLowerCase();
					valB = (b.hostname || '').toLowerCase();
					return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
				case 'ip':
					valA = a.ip || '';
					valB = b.ip || '';
					return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
				case 'ostype':
					valA = (a.ostype || '').toLowerCase();
					valB = (b.ostype || '').toLowerCase();
					return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
				case 'rx':
				case 'tx':
					valA = parseInt(a[sortField]) || 0;
					valB = parseInt(b[sortField]) || 0;
					break;
				case 'lastseen':
					valA = a.lastseen || '';
					valB = b.lastseen || '';
					return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
				default:
					valA = 0;
					valB = 0;
			}
			return sortAsc ? valA - valB : valB - valA;
		});
		return entries;
	}

	function renderTable() {
		const sortedPeers = getSortedPeers();

		const table = E('table', { 'class': 'cbi-table' }, [
			E('tr', { 'class': 'cbi-table-header' }, peerTableHeaders.map(header => {
				let th_style = 'padding-right: 20px; text-align: left; cursor: pointer; user-select: none;';
				if (header.style) {
					th_style += header.style;
				}
				const isSorted = sortField === header.field;
				const arrow = isSorted ? (sortAsc ? ' ▲' : ' ▼') : '';
				return E('th', {
					'class': 'cbi-table-cell',
					'style': th_style,
					'click': function() {
						if (sortField === header.field) {
							sortAsc = !sortAsc;
						} else {
							sortField = header.field;
							sortAsc = true;
						}
						renderTable();
					}
				}, header.text + arrow);
			})),

			...sortedPeers.map(([peerid, peer]) => {
				const td_style = 'padding-right: 20px;';

				return E('tr', { 'class': 'cbi-rowstyle-1' }, [
					E('td', { 'class': 'cbi-value-field', 'style': td_style },
						E('span', {
							'style': `color:${peer.exit_node ? 'blue' : (peer.online ? 'green' : 'gray')};`,
							'title': (peer.exit_node ? _('Exit Node') + ' ' : '') + (peer.online ? _('Online') : _('Offline'))
						}, peer.online ? '●' : '○')
					),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, E('strong', {}, peer.hostname + (peer.exit_node_option ? ' (ExNode)' : ''))),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, (Array.isArray(peer.ip) ? peer.ip.join(', ') : peer.ip) || 'N/A'),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, peer.ostype || 'N/A'),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, formatConnectionInfo(peer.linkadress || '-')),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, formatBytes(peer.rx)),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, formatBytes(peer.tx)),
					E('td', { 'class': 'cbi-value-field', 'style': td_style }, formatLastSeen(peer.lastseen))
				]);
			})
		]);

		container.textContent = '';
		container.appendChild(table);
	}

	renderTable();
	return container;
}

// Render network topology diagram
function renderTopology(status) {
	if (!status || !status.hasOwnProperty('status') || status.status != 'running') {
		return E('em', {}, _('Tailscale status error'));
	}

	const peers = status.peers;
	if (!peers || Object.keys(peers).length === 0) {
		return E('p', {}, _('No peer devices found.'));
	}

	const selfIp = status.ipv4 || '100.64.0.1';
	const peerEntries = Object.entries(peers);
	const nodeCount = peerEntries.length + 1;

	// Canvas dimensions
	const width = 700;
	const height = Math.max(400, Math.min(600, nodeCount * 50));
	const centerX = width / 2;
	const centerY = height / 2;
	const radius = Math.min(width, height) / 2 - 80;

	// OS icon mapping
	const osIcons = {
		'linux': '🐧',
		'windows': '🪟',
		'macos': '🍎',
		'ios': '📱',
		'android': '🤖',
		'default': '💻'
	};

	function getOsIcon(osType) {
		if (!osType) return osIcons.default;
		const os = osType.toLowerCase();
		if (os.includes('linux')) return osIcons.linux;
		if (os.includes('windows')) return osIcons.windows;
		if (os.includes('macos') || os.includes('darwin')) return osIcons.macos;
		if (os.includes('ios')) return osIcons.ios;
		if (os.includes('android')) return osIcons.android;
		return osIcons.default;
	}

	// Calculate line width based on traffic
	function getLineWidth(rx, tx) {
		const totalTraffic = (parseInt(rx) || 0) + (parseInt(tx) || 0);
		if (totalTraffic === 0) return 1;
		if (totalTraffic < 1024) return 1;           // < 1KB
		if (totalTraffic < 1024 * 1024) return 2;    // < 1MB
		if (totalTraffic < 1024 * 1024 * 100) return 3; // < 100MB
		return 4;                                     // >= 100MB
	}

	// Build nodes and links from current data
	function buildGraphData(peersData) {
		const nodes = [];
		const links = [];

		// Add self node (center)
		nodes.push({
			id: 'self',
			x: centerX,
			y: centerY,
			r: 30,
			fill: '#4CAF50',
			stroke: '#2E7D32',
			icon: '🏠',
			label: 'Router',
			ip: selfIp,
			draggable: false,
			alpha: 1,
			peerData: { hostname: 'Router', ip: selfIp, ostype: 'OpenWrt', online: true, rx: 0, tx: 0 }
		});

		// Add peer nodes
		const entries = Object.entries(peersData);
		entries.forEach(([peerid, peer], index) => {
			const angle = (2 * Math.PI * index) / entries.length - Math.PI / 2;
			const x = centerX + radius * Math.cos(angle);
			const y = centerY + radius * Math.sin(angle);

			const isOnline = peer.online;
			const isDirect = peer.linkadress && !String(peer.linkadress).includes('relay') && !String(peer.linkadress).includes('DERP');
			const nodeColor = isOnline ? (isDirect ? '#2196F3' : '#FF9800') : '#9E9E9E';
			const strokeColor = isOnline ? (isDirect ? '#1565C0' : '#E65100') : '#616161';
			const lineColor = isOnline ? (isDirect ? '#4CAF50' : '#FF9800') : '#BDBDBD';
			const lineDash = isOnline ? (isDirect ? [] : [5, 5]) : [3, 3];

			// Add link with traffic-based width
			links.push({
				source: 0,
				target: nodes.length,
				color: lineColor,
				dash: lineDash,
				width: getLineWidth(peer.rx, peer.tx)
			});

			// Add node with alpha for animation
			nodes.push({
				id: peerid,
				x: x,
				y: y,
				r: 25,
				fill: nodeColor,
				stroke: strokeColor,
				icon: getOsIcon(peer.ostype),
				label: (peer.hostname || 'Unknown').substring(0, 10),
				ip: Array.isArray(peer.ip) ? (peer.ip[0] || 'N/A') : (peer.ip || 'N/A'),
				isExit: peer.exit_node_option,
				draggable: true,
				alpha: isOnline ? 1 : 0.6,
				peerData: peer
			});
		});

		return { nodes, links };
	}

	let { nodes, links } = buildGraphData(peers);
	let prevOnlineState = {};
	nodes.forEach(n => { prevOnlineState[n.id] = n.peerData.online; });

	// Animation state for node transitions
	let animationAlpha = {};
	nodes.forEach(n => { animationAlpha[n.id] = n.alpha; });

	// Transform state for zoom and pan
	let transform = { x: 0, y: 0, scale: 1 };
	let isPanning = false;
	let panStartX = 0;
	let panStartY = 0;

	// Create canvas container
	const canvas = E('canvas', {
		'width': width,
		'height': height,
		'style': 'cursor: grab; border-radius: 8px;'
	});

	// Tooltip element
	const tooltip = E('div', {
		'class': 'topology-tooltip',
		'style': 'position: absolute; display: none; background: rgba(0,0,0,0.8); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; z-index: 1000;'
	});

	// Detail panel element
	const detailPanel = E('div', {
		'class': 'cbi-section',
		'style': 'position: absolute; right: 10px; top: 10px; width: 250px; display: none; z-index: 1001; font-size: 13px;'
	});

	// State for dragging
	let dragNode = null;
	let dragOffsetX = 0;
	let dragOffsetY = 0;
	let hoveredNode = null;
	let selectedNode = null;

	// Draw function
	function draw() {
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		// Clear canvas with transparent background
		ctx.clearRect(0, 0, width, height);

		// Apply transform
		ctx.save();
		ctx.translate(transform.x, transform.y);
		ctx.scale(transform.scale, transform.scale);

		// Draw grid pattern for visual reference
		ctx.strokeStyle = '#f0f0f0';
		ctx.lineWidth = 0.5;
		for (let x = 0; x < width; x += 50) {
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();
		}
		for (let y = 0; y < height; y += 50) {
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
			ctx.stroke();
		}

		// Draw links
		links.forEach(link => {
			const source = nodes[link.source];
			const target = nodes[link.target];
			ctx.beginPath();
			ctx.strokeStyle = link.color;
			ctx.lineWidth = link.width;
			ctx.globalAlpha = 0.6;
			ctx.setLineDash(link.dash);
			ctx.moveTo(source.x, source.y);
			ctx.lineTo(target.x, target.y);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.globalAlpha = 1;
		});

		// Draw nodes
		nodes.forEach((node, index) => {
			const alpha = animationAlpha[node.id] || 1;
			ctx.globalAlpha = alpha;

			// Draw circle
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
			ctx.fillStyle = node.fill;
			ctx.fill();
			ctx.strokeStyle = node.stroke;
			ctx.lineWidth = node === hoveredNode || node === selectedNode ? 4 : 2;
			ctx.stroke();

			// Draw icon
			ctx.font = '16px Arial';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillStyle = 'white';
			ctx.fillText(node.icon, node.x, node.y - 3);

			// Draw label
			ctx.font = 'bold 9px Arial';
			ctx.fillStyle = 'white';
			ctx.fillText(node.label, node.x, node.y + 15);

			// Draw IP below node
			ctx.font = '9px Arial';
			ctx.fillStyle = '#555';
			ctx.fillText(node.ip, node.x, node.y + node.r + 15);

			// Draw exit node indicator
			if (node.isExit) {
				ctx.font = '12px Arial';
				ctx.fillStyle = '#E91E63';
				ctx.fillText('⚡', node.x + 20, node.y - 15);
			}

			ctx.globalAlpha = 1;
		});

		ctx.restore();
	}

	// Get node at position (accounting for transform)
	function getNodeAt(canvasX, canvasY) {
		// Convert canvas coordinates to world coordinates
		const x = (canvasX - transform.x) / transform.scale;
		const y = (canvasY - transform.y) / transform.scale;

		for (let i = nodes.length - 1; i >= 0; i--) {
			const node = nodes[i];
			const dx = x - node.x;
			const dy = y - node.y;
			if (dx * dx + dy * dy <= node.r * node.r) {
				return node;
			}
		}
		return null;
	}

	// Update detail panel
	function updateDetailPanel(node) {
		if (!node) {
			detailPanel.style.display = 'none';
			selectedNode = null;
			return;
		}

		selectedNode = node;
		const peer = node.peerData;
		const isOnline = peer.online;
		const isDirect = peer.linkadress && !String(peer.linkadress).includes('relay') && !String(peer.linkadress).includes('DERP');

		const statusColor = isOnline ? 'green' : 'gray';
		const statusText = isOnline ? _('Online') : _('Offline');
		const connType = node.id === 'self' ? _('Local') : (isDirect ? _('Direct') : _('Relay'));
		const connInfo = node.id === 'self' ? '-' : formatConnectionInfo(peer.linkadress || '-');

		detailPanel.innerHTML = '';
		detailPanel.appendChild(E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;' }, [
			E('strong', { 'style': 'font-size: 14px;' }, node.icon + ' ' + node.label),
			E('button', {
				'style': 'background: none; border: none; cursor: pointer; font-size: 16px; color: #999;',
				'click': function() { updateDetailPanel(null); draw(); }
			}, '×')
		]));
		detailPanel.appendChild(E('hr', { 'style': 'margin: 8px 0; border: none; border-top: 1px solid #eee;' }));
		detailPanel.appendChild(E('div', {}, [
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('Status') + ': '),
				E('span', { 'style': 'color: ' + statusColor + '; font-weight: bold;' }, statusText)
			]),
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('IP') + ': '),
				E('span', {}, node.ip)
			]),
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('OS') + ': '),
				E('span', {}, peer.ostype || 'N/A')
			]),
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('Connection') + ': '),
				E('span', {}, connType)
			]),
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('Connection Info') + ': '),
				E('span', {}, connInfo)
			]),
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('RX') + ': '),
				E('span', {}, formatBytes(peer.rx))
			]),
			E('div', { 'style': 'margin-bottom: 6px;' }, [
				E('span', { 'style': 'color: #666;' }, _('TX') + ': '),
				E('span', {}, formatBytes(peer.tx))
			]),
			E('div', {}, [
				E('span', { 'style': 'color: #666;' }, _('Last Seen') + ': '),
				E('span', {}, formatLastSeen(peer.lastseen))
			])
		]));

		detailPanel.style.display = 'block';
	}

	// Mouse event handlers for zoom and pan
	canvas.addEventListener('wheel', (e) => {
		e.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const mouseX = e.clientX - rect.left;
		const mouseY = e.clientY - rect.top;

		const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
		const newScale = Math.max(0.5, Math.min(3, transform.scale * zoomFactor));

		// Zoom toward mouse position
		transform.x = mouseX - (mouseX - transform.x) * (newScale / transform.scale);
		transform.y = mouseY - (mouseY - transform.y) * (newScale / transform.scale);
		transform.scale = newScale;

		draw();
	});

	canvas.addEventListener('mousedown', (e) => {
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const node = getNodeAt(x, y);
		
		if (node && node.draggable) {
			dragNode = node;
			const worldX = (x - transform.x) / transform.scale;
			const worldY = (y - transform.y) / transform.scale;
			dragOffsetX = worldX - node.x;
			dragOffsetY = worldY - node.y;
			canvas.style.cursor = 'grabbing';
			e.preventDefault();
		} else if (!node) {
			// Start panning
			isPanning = true;
			panStartX = x - transform.x;
			panStartY = y - transform.y;
			canvas.style.cursor = 'grabbing';
			e.preventDefault();
		}
	});

	canvas.addEventListener('mousemove', (e) => {
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		if (dragNode) {
			const worldX = (x - transform.x) / transform.scale;
			const worldY = (y - transform.y) / transform.scale;
			dragNode.x = Math.max(dragNode.r, Math.min(width - dragNode.r, worldX - dragOffsetX));
			dragNode.y = Math.max(dragNode.r, Math.min(height - dragNode.r, worldY - dragOffsetY));
			draw();
		} else if (isPanning) {
			transform.x = x - panStartX;
			transform.y = y - panStartY;
			draw();
		} else {
			const node = getNodeAt(x, y);
			if (node !== hoveredNode) {
				hoveredNode = node;
				canvas.style.cursor = node ? (node.draggable ? 'grab' : 'pointer') : 'default';
				draw();
			}

			// Update tooltip
			if (node) {
				tooltip.style.display = 'block';
				tooltip.style.left = (e.clientX + 15) + 'px';
				tooltip.style.top = (e.clientY + 15) + 'px';
				tooltip.innerHTML = '<strong>' + node.label + '</strong><br>' + node.ip;
			} else {
				tooltip.style.display = 'none';
			}
		}
	});

	canvas.addEventListener('mouseup', (e) => {
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		if (dragNode) {
			dragNode = null;
			canvas.style.cursor = hoveredNode ? 'grab' : 'default';
		} else if (isPanning) {
			isPanning = false;
			canvas.style.cursor = 'default';
		} else {
			// Click on node to show detail panel
			const node = getNodeAt(x, y);
			if (node) {
				updateDetailPanel(node);
				draw();
			}
		}
	});

	canvas.addEventListener('mouseleave', () => {
		dragNode = null;
		isPanning = false;
		hoveredNode = null;
		tooltip.style.display = 'none';
		draw();
	});

	// Initial draw
	draw();

	// Real-time refresh every 10 seconds via L.Poll so the timer is
	// automatically stopped when the user navigates away from this LuCI view.
	const topologyPoll = function() {
		return L.resolveDefault(callGetStatus(), {}).then(function(newStatus) {
			if (!newStatus || newStatus.status !== 'running' || !newStatus.peers) return;

			// Check for state changes and trigger animations
			const newEntries = Object.entries(newStatus.peers);
			newEntries.forEach(([peerid, peer]) => {
				const wasOnline = prevOnlineState[peerid];
				const isOnline = peer.online;

				if (wasOnline !== undefined && wasOnline !== isOnline) {
					animationAlpha[peerid] = 0.3;
					setTimeout(function() {
						animationAlpha[peerid] = isOnline ? 1 : 0.6;
						draw();
					}, 500);
				}
				prevOnlineState[peerid] = isOnline;
			});

			const newData = buildGraphData(newStatus.peers);

			// Preserve node positions for existing nodes
			newData.nodes.forEach(newNode => {
				const existingNode = nodes.find(n => n.id === newNode.id);
				if (existingNode) {
					newNode.x = existingNode.x;
					newNode.y = existingNode.y;
				}
			});

			nodes = newData.nodes;
			links = newData.links;
			draw();
		});
	};
	L.Poll.add(topologyPoll, 10);

	// Build legend
	const legend = E('div', {
		'class': 'cbi-section',
		'style': 'margin-top: 15px; padding: 10px; font-size: 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;'
	}, [
		E('strong', {}, _('Legend') + ':'),
		E('span', { 'style': 'margin-left: 5px;' }, '🟢 ' + _('Direct Connection')),
		E('span', { 'style': 'margin-left: 5px;' }, '🟡 ' + _('Relay Connection')),
		E('span', { 'style': 'margin-left: 5px;' }, '⚪ ' + _('Offline')),
		E('span', { 'style': 'margin-left: 5px;' }, '⚡ ' + _('Exit Node')),
		E('span', { 'style': 'margin-left: 15px; color: #666;' }, _('Scroll to zoom, drag to pan, click node for details'))
	]);

	// Build toolbar
	const toolbar = E('div', {
		'style': 'margin-bottom: 10px; display: flex; gap: 8px;'
	}, [
		E('button', {
			'class': 'cbi-button',
			'style': 'font-size: 12px;',
			'click': function() {
				transform = { x: 0, y: 0, scale: 1 };
				draw();
			}
		}, _('Reset View')),
		E('button', {
			'class': 'cbi-button',
			'style': 'font-size: 12px;',
			'click': function() {
				transform.scale = Math.min(3, transform.scale * 1.2);
				draw();
			}
		}, _('Zoom In')),
		E('button', {
			'class': 'cbi-button',
			'style': 'font-size: 12px;',
			'click': function() {
				transform.scale = Math.max(0.5, transform.scale * 0.8);
				draw();
			}
		}, _('Zoom Out'))
	]);

	return E('div', { 'style': 'position: relative;' }, [toolbar, canvas, tooltip, detailPanel, legend]);
}

// Load logs function
function loadLogs(container) {
	container.textContent = _('Loading logs...');
	callGetLogs(100).then(function(res) {
		if (res && res.logs) {
			container.textContent = res.logs.join('\n');
			container.scrollTop = container.scrollHeight;
		} else {
			container.textContent = _('No logs available');
		}
	}).catch(function(err) {
		container.textContent = _('Error loading logs: %s').format(err.message || err);
	});
}

// Ping function
function runPing() {
	const target = document.getElementById('ping-target').value.trim();
	if (!target) {
		ui.addNotification(null, E('p', {}, _('Please enter a target IP or hostname')), 'warning');
		return;
	}
	
	const output = document.getElementById('ping-output');
	output.style.display = 'block';
	output.textContent = _('Pinging %s...').format(target);
	
	callPing(target).then(function(res) {
		if (res && res.success) {
			output.textContent = res.output.join('\n');
		} else {
			output.textContent = _('Ping failed: %s').format(res.error || 'Unknown error');
		}
	}).catch(function(err) {
		output.textContent = _('Error: %s').format(err.message || err);
	});
}

// Traceroute function
function runTraceroute() {
	const target = document.getElementById('traceroute-target').value.trim();
	if (!target) {
		ui.addNotification(null, E('p', {}, _('Please enter a target IP or hostname')), 'warning');
		return;
	}
	
	const output = document.getElementById('traceroute-output');
	output.style.display = 'block';
	output.textContent = _('Running traceroute to %s...').format(target);
	
	callTraceroute(target).then(function(res) {
		if (res && res.success) {
			output.textContent = res.output.join('\n');
		} else {
			output.textContent = _('Traceroute failed: %s').format(res.error || 'Unknown error');
		}
	}).catch(function(err) {
		output.textContent = _('Error: %s').format(err.message || err);
	});
}

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callGetStatus(), { running: '', peers: [] }),
			L.resolveDefault(callGetSettings(), { accept_routes: false }),
			L.resolveDefault(callGetSubroutes(), { routes: [] })
		])
		.then(function([status, settings_from_rpc, subroutes]) {
			return uci.load('tailscale').then(function() {
				if (uci.get('tailscale', 'settings') === null) {
					// No existing settings found; initialize UCI with RPC settings
					uci.add('tailscale', 'settings', 'settings');
					uci.set('tailscale', 'settings', 'service_enabled', '1');
					uci.set('tailscale', 'settings', 'fw_mode', 'nftables');
					uci.set('tailscale', 'settings', 'accept_routes', (settings_from_rpc.accept_routes ? '1' : '0'));
					uci.set('tailscale', 'settings', 'advertise_exit_node', ((settings_from_rpc.advertise_exit_node || false) ? '1' : '0'));
					uci.set('tailscale', 'settings', 'advertise_routes', (settings_from_rpc.advertise_routes || []).join(', '));
					uci.set('tailscale', 'settings', 'exit_node', settings_from_rpc.exit_node || '');
					uci.set('tailscale', 'settings', 'exit_node_allow_lan_access', ((settings_from_rpc.exit_node_allow_lan_access || false) ? '1' : '0'));
					uci.set('tailscale', 'settings', 'ssh', ((settings_from_rpc.ssh || false) ? '1' : '0'));
					uci.set('tailscale', 'settings', 'shields_up', ((settings_from_rpc.shields_up || false) ? '1' : '0'));
					uci.set('tailscale', 'settings', 'runwebclient', ((settings_from_rpc.runwebclient || false) ? '1' : '0'));
					uci.set('tailscale', 'settings', 'nosnat', ((settings_from_rpc.nosnat || false) ? '1' : '0'));
					uci.set('tailscale', 'settings', 'dns_mode', 'disabled');
					uci.set('tailscale', 'settings', 'hostname', '');
					uci.set('tailscale', 'settings', 'enable_relay', '0');
					uci.set('tailscale', 'settings', 'relay_server_port', '40000');

					uci.set('tailscale', 'settings', 'daemon_reduce_memory', '0');
					uci.set('tailscale', 'settings', 'daemon_mtu', '');
					return uci.save();
				}
			}).then(function() {
				// Migrate from old disable_magic_dns to dns_mode if needed
				if (uci.get('tailscale', 'settings', 'dns_mode') === null) {
					var oldMagicDns = uci.get('tailscale', 'settings', 'disable_magic_dns');
					uci.set('tailscale', 'settings', 'dns_mode', oldMagicDns === '1' ? 'disabled' : 'magicdns');
					uci.unset('tailscale', 'settings', 'disable_magic_dns');
					return uci.save();
				}
			}).then(function() {
				return [status, settings_from_rpc, subroutes];
			});
		});
	},

	render ([status = {}, settings = {}, subroutes_obj]) {
		const subroutes = (subroutes_obj && subroutes_obj.routes) ? subroutes_obj.routes : [];

		let s;
		map = new form.Map('tailscale', _('Tailscale'), _('Tailscale is a mesh VPN solution that makes it easy to connect your devices securely. This configuration page allows you to manage Tailscale settings on your OpenWrt device.'));

		s = map.section(form.NamedSection, '_status');
		s.anonymous = true;
		s.render = function (section_id) {
			L.Poll.add(
				function () {
					return getRunningStatus().then(function (res) {
						const view = document.getElementById("service_status_display");
						if (view) {
							const content = renderStatus(res);
							view.replaceChildren(content);
						}

						const devicesView = document.getElementById("tailscale_devices_display");
						if (devicesView) {
							devicesView.replaceChildren(renderDevices(res));
						}

						// login button only available when logged out
						const login_btn=document.getElementsByClassName('cbi-button cbi-button-apply')[0];
						if(login_btn) { login_btn.disabled=(res.status != 'logout'); }
					});
				}, 10);

			return E('div', { 'id': 'service_status_display', 'class': 'cbi-value' },
				_('Collecting data ...')
			);
		}

		// Bind settings to the 'settings' section of uci
		s = map.section(form.NamedSection, 'settings', 'settings', null);
		s.dynamic = true;

		// Create the "General Settings" tab and apply tailscaleSettingsConf
		s.tab('general', _('General Settings'));

		defTabOpts(s, 'general', tailscaleSettingsConf, { optional: false });

		const relayPort = s.taboption('general', form.Value, 'relay_server_port', _('Peer Relay Port'),
			_('UDP port for the Peer Relay service. Open this port on your router firewall/NAT.')
		);
		relayPort.datatype = 'port';
		relayPort.placeholder = '40000';
		relayPort.rmempty = false;
		relayPort.depends('enable_relay', '1');

		const en = s.taboption('general', form.ListValue, 'exit_node', _('Exit Node'), _('Select an exit node from the list. If enabled, Allow LAN Access is enabled implicitly.'));
		en.value('', _('None'));
		if (status.peers) {
			Object.values(status.peers).forEach(function(peer) {
				if (peer.exit_node_option) {
					const primaryIp = Array.isArray(peer.ip) ? peer.ip[0] : peer.ip;
					if (!primaryIp) return;
					const label = peer.hostname ? `${peer.hostname} (${primaryIp})` : primaryIp;
					en.value(primaryIp, label);
				}
			});
		}
		en.rmempty = true;
		en.cfgvalue = function(section_id) {
			if (status && status.status === 'running' && status.peers) {
				for (const id in status.peers) {
					if (status.peers[id].exit_node) {
						const ip = status.peers[id].ip;
						return Array.isArray(ip) ? (ip[0] || '') : (ip || '');
					}
				}
				return '';
			}
			return uci.get('tailscale', 'settings', 'exit_node') || '';
		};

		const o = s.taboption('general', form.DynamicList, 'advertise_routes', _('Advertise Routes'),_('Advertise subnet routes behind this device. Select from the detected subnets below or enter custom routes (comma-separated).'));
		if (subroutes.length > 0) {
			subroutes.forEach(function(subnet) {
				o.value(subnet, subnet);
			});
		}
		o.rmempty = true;

		const fwBtn = s.taboption('general', form.Button, '_setup_firewall', _('Auto Configure Firewall'));
		fwBtn.description = _('Essential configuration for Subnet Routing (Site-to-Site) and Exit Node features.')
		+'<br>'+_('It automatically creates the tailscale interface, sets up firewall zones for LAN <-> Tailscale forwarding,')
		+'<br>'+_('and enables Masquerading and MSS Clamping (MTU fix) to ensure stable connections.');
		fwBtn.inputstyle = 'action';
		fwBtn.onclick = function() {
			return callSetupFirewall().then(function(res) {
				if (res?.error) {
					ui.addNotification(null, E('p', {}, _('Failed to configure firewall: %s').format(res.error)), 'error');
				} else {
					const msg = res?.message || _('Firewall configuration applied.');
					ui.addNotification(null, E('p', {}, msg), 'info');
				}
			}).catch(function(err) {
				ui.addNotification(null, E('p', {}, _('Failed to configure firewall: %s').format(err?.message || err || 'Unknown error')), 'error');
			}).then(function() {
				return new Promise(function(resolve) {
					window.setTimeout(resolve, 3000);
				});
			});
		};

		const helpTitle = s.taboption('general', form.DummyValue, '_help_title');
		helpTitle.title = _('How to enable Site-to-Site?');
		helpTitle.render = function() {
			return E('div', { 'class': 'cbi-value', 'style': 'margin-top: 1em; border-top: 1px font-weight: bold;' }, [
				E('label', { 'class': 'cbi-value-title' }, this.title),
				E('div', { 'class': 'cbi-value-field', 'style': 'line-height: 1.6em; font-size: 95%; color: #555;' }, [
					_('1. Select "Accept Routes" (to access remote devices).'), E('br'),
					_('2. In "Advertise Routes", select your local subnet (to allow remote devices to access this LAN).'), E('br'),
					_('3. Click "Auto Configure Firewall" (to allow traffic forwarding).'), E('br'),
					E('strong', { 'style': 'color: #d9534f;' }, _('[Important] Log in to the Tailscale admin console and manually enable "Subnet Routes" for this device.'))
				])
			]);
		};

		// Create the account settings
		s.tab('account', _('Account Settings'));
		defTabOpts(s, 'account', accountConf, { optional: false });

		const loginBtn = s.taboption('account', form.Button, '_login', _('Login'),
		_('Click to get a login URL for this device.')
		+'<br>'+_('If the timeout is displayed, you can refresh the page and click Login again.'));
		loginBtn.inputstyle = 'apply';

		const customLoginUrl = s.taboption('account', form.Value, 'custom_login_url',
			_('Custom Login Server'),
			_('Optional: Specify a custom control server URL (e.g., a Headscale instance, %s).'.format('https://example.com'))
			+'<br>'+_('Leave blank for default Tailscale control plane.')
		);
		customLoginUrl.placeholder = '';
		customLoginUrl.rmempty = true;

		const customLoginAuthKey = s.taboption('account', form.Value, 'custom_login_AuthKey',
			_('Custom Login Server Auth Key'),
			_('Optional: Specify an authentication key for the custom control server. Leave blank if not required.')
			+'<br>'+_('If you are using custom login server but not providing an Auth Key, will redirect to the login page without pre-filling the key.')
		);
		customLoginAuthKey.placeholder = '';
		customLoginAuthKey.rmempty = true;

		const logoutBtn = s.taboption('account', form.Button, '_logout', _('Logout'),
		_('Click to Log out account on this device.')
		+'<br>'+_('Disconnect from Tailscale and expire current node key.'));
		logoutBtn.inputstyle = 'apply';
		logoutBtn.id = 'tailscale_logout_btn';

		loginBtn.onclick = function() {
			const customServerInput = document.getElementById('widget.cbid.tailscale.settings.custom_login_url');
			const customServer = customServerInput ? customServerInput.value : '';
			const customserverAuthInput = document.getElementById('widget.cbid.tailscale.settings.custom_login_AuthKey');
			const customServerAuth = customserverAuthInput ? customserverAuthInput.value : '';
			const loginWindow = window.open('', '_blank');
			if (!loginWindow) {
				ui.addTimeLimitedNotification(null, [ E('p', _('Could not open a new tab. Please check if your browser or an extension blocked the pop-up.')) ], 10000, 'error');
				return;
			}
			// Display a prompt message in the new window
			const doc = loginWindow.document;
			doc.body.innerHTML =
				'<h2>' + _('Tailscale Login') + '</h2>' +
				'<p>' + _('Requesting Tailscale login URL... Please wait.') + '</p>' +
				'<p>' + _('This can take up to 30 seconds.') + '</p>';

			ui.showModal(_('Requesting Login URL...'), E('em', {}, _('Please wait.')));
			const payload = {
				loginserver: customServer || '',
				loginserver_authkey: customServerAuth || ''
			};
			// Show a "loading" modal and execute the asynchronous RPC call
			ui.showModal(_('Requesting Login URL...'), E('em', {}, _('Please wait.')));
			return callDoLogin(payload).then(function(res) {
				ui.hideModal();
				if (res && res.url) {
					// After successfully obtaining the URL, redirect the previously opened tab
					loginWindow.location.href = res.url;
				} else {
					// If it fails, inform the user and they can close the new tab
					doc.body.innerHTML =
						'<h2>' + _('Error') + '</h2>' +
						'<p>' + _('Failed to get login URL. You may close this tab.') + '</p>';
					ui.addTimeLimitedNotification(null, [ E('p', _('Failed to get login URL: Invalid response from server.')) ], 7000, 'error');
				}
			}).catch(function(err) {
				ui.hideModal();
				ui.addTimeLimitedNotification(null, [ E('p', _('Failed to get login URL: %s').format(err.message || _('Unknown error'))) ], 7000, 'error');
			});
		};

		logoutBtn.onclick = function() {
			const confirmationContent = E([
				E('p', {}, _('Are you sure you want to log out?')
					+'<br>'+_('This will disconnect this device from your Tailnet and require you to re-authenticate.')),

				E('div', { 'style': 'text-align: right; margin-top: 1em;' }, [
					E('button', {
						'class': 'cbi-button',
						'click': ui.hideModal
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'cbi-button cbi-button-negative',
						'click': function() {
							ui.hideModal();
							ui.showModal(_('Logging out...'), E('em', {}, _('Please wait.')));

							return callDoLogout().then(function(res) {
								ui.hideModal();
								ui.addTimeLimitedNotification(null, [ E('p', _('Successfully logged out.')) ], 5000, 'info');
							}).catch(function(err) {
								ui.hideModal();
								ui.addTimeLimitedNotification(null, [ E('p', _('Logout failed: %s').format(err.message || _('Unknown error'))) ], 7000, 'error');
							});
						}
					}, _('Logout'))
				])
			]);
			ui.showModal(_('Confirm Logout'), confirmationContent);
		};

		s.tab('devices', _('Devices List'));
		const devicesSection = s.taboption('devices', form.DummyValue, '_devices');
		devicesSection.render = function () {
			return E('div', { 'id': 'tailscale_devices_display', 'class': 'cbi-value' }, renderDevices(status));
		};

		s.tab('topology', _('Network Topology'));
		const topologySection = s.taboption('topology', form.DummyValue, '_topology');
		topologySection.render = function () {
			return E('div', { 'id': 'tailscale_topology_display', 'class': 'cbi-value' }, renderTopology(status));
		};

		// Logs tab
		s.tab('logs', _('Logs'));
		const logsSection = s.taboption('logs', form.DummyValue, '_logs');
		logsSection.render = function () {
			const logContainer = E('div', { 'class': 'cbi-value' });
			const logContent = E('pre', { 
				'id': 'tailscale-logs',
				'style': 'background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 6px; max-height: 500px; overflow-y: auto; font-size: 12px; font-family: monospace;'
			}, _('Loading logs...'));
			
			const refreshBtn = E('button', {
				'class': 'cbi-button',
				'style': 'margin-top: 10px;',
				'click': function() { loadLogs(logContent); }
			}, _('Refresh Logs'));
			
			logContainer.appendChild(logContent);
			logContainer.appendChild(refreshBtn);
			loadLogs(logContent);
			return logContainer;
		};

		// Tools tab
		s.tab('tools', _('Network Tools'));
		const toolsSection = s.taboption('tools', form.DummyValue, '_tools');
		toolsSection.render = function () {
			const toolsContainer = E('div', { 'class': 'cbi-value' });
			
			// Ping tool
			const pingSection = E('div', { 'style': 'margin-bottom: 20px;' }, [
				E('h3', { 'style': 'margin-bottom: 10px;' }, _('Ping Test')),
				E('div', { 'style': 'display: flex; gap: 10px; align-items: center;' }, [
					E('input', {
						'id': 'ping-target',
						'type': 'text',
						'placeholder': _('Enter IP or hostname (e.g., 100.64.0.1)'),
						'style': 'flex: 1; padding: 8px; border: 1px solid #ccc; border-radius: 4px;'
					}),
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': function() { runPing(); }
					}, _('Run Ping'))
				]),
				E('pre', {
					'id': 'ping-output',
					'style': 'background: #f5f5f5; padding: 10px; border-radius: 4px; margin-top: 10px; display: none; max-height: 200px; overflow-y: auto;'
				})
			]);
			
			// Traceroute tool
			const tracerouteSection = E('div', { 'style': 'margin-bottom: 20px;' }, [
				E('h3', { 'style': 'margin-bottom: 10px;' }, _('Traceroute')),
				E('div', { 'style': 'display: flex; gap: 10px; align-items: center;' }, [
					E('input', {
						'id': 'traceroute-target',
						'type': 'text',
						'placeholder': _('Enter IP or hostname'),
						'style': 'flex: 1; padding: 8px; border: 1px solid #ccc; border-radius: 4px;'
					}),
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': function() { runTraceroute(); }
					}, _('Run Traceroute'))
				]),
				E('pre', {
					'id': 'traceroute-output',
					'style': 'background: #f5f5f5; padding: 10px; border-radius: 4px; margin-top: 10px; display: none; max-height: 300px; overflow-y: auto;'
				})
			]);
			
			// Quick actions
			const quickActions = E('div', {}, [
				E('h3', { 'style': 'margin-bottom: 10px;' }, _('Quick Actions')),
				E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
					E('button', {
						'class': 'cbi-button',
						'click': function() { 
							document.getElementById('ping-target').value = status.ipv4;
							runPing();
						}
					}, _('Ping Self')),
					E('button', {
						'class': 'cbi-button',
						'click': function() { 
							document.getElementById('ping-target').value = '100.100.100.100';
							runPing();
						}
					}, _('Ping Tailscale DNS')),
					E('button', {
						'class': 'cbi-button',
						'click': function() { 
							document.getElementById('ping-target').value = '8.8.8.8';
							runPing();
						}
					}, _('Ping Google DNS'))
				])
			]);
			
			toolsContainer.appendChild(pingSection);
			toolsContainer.appendChild(tracerouteSection);
			toolsContainer.appendChild(quickActions);
			return toolsContainer;
		};

		// Create the "Daemon Settings" tab and apply daemonConf
		//s.tab('daemon', _('Daemon Settings'));
		//defTabOpts(s, 'daemon', daemonConf, { optional: false });

		return map.render();
	},

	// The handleSaveApply function saves UCI changes then applies them via the
	// standard OpenWrt apply mechanism, which triggers /etc/init.d/tailscale-settings
	// and provides automatic rollback protection if the device becomes unreachable.
	handleSaveApply(ev, mode) {
		return map.save().then(function () {
			return ui.changes.apply(mode == '0');
		});
	},

	handleSave: null,
	handleReset: null
});
