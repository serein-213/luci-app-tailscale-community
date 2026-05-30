#!/usr/bin/env ucode

'use strict';

import { access, popen, readfile, writefile, unlink } from 'fs';
import { cursor } from 'uci';

const uci = cursor();

function exec(command) {
	let stdout_content = '';
	let p = popen(command, 'r');
	if (p == null) {
		return { code: -1, stdout: [], stderr: `Failed to execute: ${command}` };
	}

	for (let line = p.read('line'); length(line); line = p.read('line')) {
		stdout_content = stdout_content + line;
	}
	stdout_content = rtrim(stdout_content);
	stdout_content = split(stdout_content, '\n');

	let exit_code = p.close();
	let stderr_content = '';
	if (exit_code != 0) {
		stderr_content = stdout_content;
	}
	return { code: exit_code, stdout: stdout_content, stderr: stderr_content };
}

function shell_quote(s) {
	if (s == null || s == '') return "''";
	return "'" + replace(s, "'", "'\\''") + "'";
}

// Get the LAN bridge device name dynamically
function get_lan_device() {
	// Try to get from UCI firewall config first
	let lan_device = uci.get('firewall', '@zone[0]', 'network');
	if (type(lan_device) == 'array') {
		lan_device = lan_device[0];
	}

	// If we got a network name, resolve to device
	if (lan_device) {
		let device = uci.get('network', lan_device, 'device');
		if (device) return device;

		// Check for bridge ports
		let ports = uci.get('network', lan_device, 'ports');
		if (ports) return 'br-' + lan_device;
	}

	// Fallback: try common names
	if (access('/sys/class/net/br-lan')) return 'br-lan';
	if (access('/sys/class/net/br0')) return 'br0';

	// Last resort: scan /sys/class/net/ for any bridge device.
	// brctl is no longer installed by default on DSA-based OpenWrt.
	let result = exec('ls /sys/class/net/ 2>/dev/null');
	if (result.code == 0) {
		for (let dev in result.stdout) {
			if (dev && (substr(dev, 0, 3) == 'br-' || substr(dev, 0, 2) == 'br') &&
				access('/sys/class/net/' + dev + '/bridge')) {
				return dev;
			}
		}
	}

	return 'br-lan'; // Default fallback
}

const methods = {};

methods.get_status = {
	call: function() {
		let data = {
			status: '',
			version: '',
			TUNMode: '',
			health: '',
			ipv4: "Not running",
			ipv6: null,
			domain_name: '',
			peers: []
		};
		if (access('/usr/sbin/tailscale')==true || access('/usr/bin/tailscale')==true){ }else{
			data.status = 'not_installed';
			return data;
		}

		let status_json_output = exec('tailscale status --json');
		let peer_map = {};
		if (status_json_output.code == 0 && length(status_json_output.stdout) > 0) {
			try {
				let status_data = json(join('',status_json_output.stdout));
				data.version = status_data?.Version || 'Unknown';
				data.health = status_data?.Health || '';
				data.TUNMode = status_data?.TUN || 'true';
				if (status_data?.BackendState == 'Running') { data.status =  'running'; }
				if (status_data?.BackendState == 'NeedsLogin') { data.status =  'logout'; }

				data.ipv4 = status_data?.Self?.TailscaleIPs?.[0] || 'No IP assigned';
				data.ipv6 = status_data?.Self?.TailscaleIPs?.[1] || null;
				data.domain_name = status_data?.CurrentTailnet?.Name || '';

				// peers list
				for (let p in status_data?.Peer) {
					p = status_data.Peer[p];
					peer_map[p.ID] = {
						ip: p?.TailscaleIPs || [],
						hostname: split(p?.DNSName || '','.')[0] || '',
						ostype: p?.OS,
						online: p?.Online,
						linkadress: (!p?.CurAddr) ? p?.Relay : p?.CurAddr,
						lastseen: p?.LastSeen,
						exit_node: !!p?.ExitNode,
						exit_node_option: !!p?.ExitNodeOption,
						tx: p?.TxBytes || '',
						rx: p?.RxBytes || ''
					};
				}
			} catch (e) {
				// Log error to system log for debugging
				exec('logger -t tailscale "Error parsing status JSON: ' + shell_quote(e.message || 'unknown') + '"');
			}
		}

		data.peers = peer_map;
		return data;
	}
};

methods.get_settings = {
	call: function() {
		let settings = {};
		uci.load('tailscale');
		let state_file_path = uci.get('tailscale', 'settings', 'state_file') || "/etc/tailscale/tailscaled.state";

		// Get UCI settings
		settings.service_enabled = uci.get('tailscale', 'settings', 'service_enabled') || '1';
		settings.fw_mode = uci.get('tailscale', 'settings', 'fw_mode') || 'nftables';
		settings.dns_mode = uci.get('tailscale', 'settings', 'dns_mode') || 'disabled';
		settings.hostname = uci.get('tailscale', 'settings', 'hostname') || '';
		settings.enable_relay = uci.get('tailscale', 'settings', 'enable_relay') || '0';
		settings.relay_server_port = uci.get('tailscale', 'settings', 'relay_server_port') || '40000';

		if (access(state_file_path)) {
			try {
				let state_content = readfile(state_file_path);
				if (state_content != null && length(state_content) > 0) {
					let state_data = json(state_content);
					if (type(state_data) == 'object') {
						let profiles_b64 = state_data?._profiles;
						if (profiles_b64 && type(profiles_b64) == 'string') {
							let decoded_profiles = b64dec(profiles_b64);
							if (decoded_profiles != null) {
								let profiles_data = json(decoded_profiles);
								let profiles_key = null;
								if (type(profiles_data) == 'object') {
									for (let key in profiles_data) {
										profiles_key = key;
										break;
									}
								}
								if (profiles_key != null) {
									profiles_key = 'profile-' + profiles_key;
									let profile_b64 = state_data?.[profiles_key];
									if (profile_b64 && type(profile_b64) == 'string') {
										let decoded_profile = b64dec(profile_b64);
										if (decoded_profile != null) {
											let status_data = json(decoded_profile);
											if (status_data != null) {
												settings.accept_routes = status_data?.RouteAll || false;
												settings.advertise_exit_node = status_data?.AdvertiseExitNode || false;
												settings.advertise_routes = status_data?.AdvertiseRoutes || [];
												settings.exit_node = status_data?.ExitNodeID || "";
												settings.exit_node_allow_lan_access = status_data?.ExitNodeAllowLANAccess || false;
												settings.shields_up = status_data?.ShieldsUp || false;
												settings.ssh = status_data?.RunSSH || false;
												settings.runwebclient = status_data?.RunWebClient || false;
												settings.nosnat = status_data?.NoSNAT || false;
											}
										}
									}
								}
							}
						}
					}
				}
			} catch (e) {
				// Log error to system log for debugging
				exec('logger -t tailscale "Error reading settings: ' + shell_quote(e.message || 'unknown') + '"');
			}
		}
		return settings;
	}
};


methods.do_login = {
	args: { form_data: {} },
	call: function(request) {
		const form_data = request.args.form_data;
		if (form_data == null || length(form_data) == 0) {
			return { error: 'Missing or invalid form_data parameter. Please provide login data.' };
		}

		let status=methods.get_status.call();
		if (status.status != 'logout') {
			return { error: 'Tailscale is already logged in and running.' };
		}

		// --- 1. Prepare and Run Login Command (Once) ---
		const loginserver = trim(form_data.loginserver) || '';
		const loginserver_authkey = trim(form_data.loginserver_authkey) || '';

		let loginargs_str = '';
		if (loginserver != '') {
			loginargs_str = ' --login-server ' + shell_quote(loginserver);
			if (loginserver_authkey != '') {
				loginargs_str = loginargs_str + ' --auth-key ' + shell_quote(loginserver_authkey);
			}
		}

		// Run in the background. Single-layer shell wrap so single-quote escaping
		// from shell_quote() remains effective. Detach stdio to keep popen from blocking.
		let login_cmd = 'tailscale login' + loginargs_str + ' </dev/null >/dev/null 2>&1 &';
		popen(login_cmd, 'r');

		// --- 2. Loop to Check Status for URL ---
		let max_attempts = 15;
		let interval = 2000;

		// Wait a bit for the login command to start
		sleep(3000);

		for (let i = 0; i < max_attempts; i++) {
			let tresult = exec('tailscale status');
			if (tresult.code == 0) {
				for (let line in tresult.stdout) {
					let trline = trim(line);
					if (index(trline, 'http') != -1) {
						let parts = split(trline, ' ');
						for (let part in parts) {
							if (index(part, 'http') != -1) {
								return { url: part };
							}
						}
					}
				}
			}
			// Increase interval after first few attempts
			let current_interval = (i < 5) ? interval : interval * 2;
			sleep(current_interval);
		}
		return { error: 'Could not retrieve login URL from tailscale command after 30 seconds.' };
	}
};

methods.do_logout = {
	call: function() {
		let status=methods.get_status.call();
		if (status.status != 'running') {
			return { error: 'Tailscale is not running. Cannot perform logout.' };
		}

		let logout_result = exec('tailscale logout');
		if (logout_result.code != 0) {
			return { error: 'Failed to logout: ' + logout_result.stderr };
		}
		return { success: true };
	}
};

methods.get_subroutes = {
	call: function() {
		try {
			let cmd = 'ip -j route';
			let result = exec(cmd);
			let subnets = [];

			if (result.code == 0 && length(result.stdout) > 0) {
				let routes_json = json(join('',result.stdout));

				for (let route in routes_json) {
					// We need to filter out local subnets
					// 1. 'dst' (target address) is not' default' (default gateway)
					// 2. 'scope' is' link' (indicating directly connected network)
					// 3. It is an IPv4 address (simple judgment: including'.')
					if (route?.dst && route.dst != 'default' && route?.scope == 'link' && index(route.dst,'.') != -1) {
						push(subnets,route.dst);
					}
				}
			}
			return { routes: subnets };
		}
		catch(e) {
			return { routes: [] };
		}
	}
};

methods.get_logs = {
	args: { lines: 50 },
	call: function(request) {
		let lines = request.args.lines || 50;
		let result = exec('logread -e tailscale | tail -n ' + lines);
		return { logs: result.stdout || [] };
	}
};

methods.ping = {
	args: { target: '' },
	call: function(request) {
		let target = request.args.target;
		if (!target) {
			return { error: 'Target is required' };
		}
		let result = exec('ping -c 3 -W 2 ' + shell_quote(target));
		return { 
			success: result.code == 0,
			output: result.stdout || [],
			error: result.code != 0 ? (result.stderr || 'Ping failed') : null
		};
	}
};

methods.traceroute = {
	args: { target: '' },
	call: function(request) {
		let target = request.args.target;
		if (!target) {
			return { error: 'Target is required' };
		}
		let result = exec('traceroute -n -m 15 -w 2 ' + shell_quote(target));
		return { 
			success: result.code == 0,
			output: result.stdout || [],
			error: result.code != 0 ? (result.stderr || 'Traceroute failed') : null
		};
	}
};

methods.setup_firewall = {
	call: function() {
		try {
			uci.load('network');
			uci.load('firewall');

			let changed_network = false;
			let changed_firewall = false;

			// 1. config Network Interface
			let net_ts = uci.get('network', 'tailscale');
			if (net_ts == null) {
				uci.set('network', 'tailscale', 'interface');
				uci.set('network', 'tailscale', 'proto', 'none');
				uci.set('network', 'tailscale', 'device', 'tailscale0');
				changed_network = true;
			} else {
				let current_dev = uci.get('network', 'tailscale', 'device');
				if (current_dev != 'tailscale0') {
					uci.set('network', 'tailscale', 'device', 'tailscale0');
					changed_network = true;
				}
			}

			// 2. config Firewall Zone
			let ts_zone_section = null;
			let fwd_lan_to_ts = false;
			let fwd_ts_to_lan = false;

			uci.foreach('firewall', 'zone', function(s) {
				if (s['name'] == 'tailscale')
					ts_zone_section = s['.name'];
			});
			uci.foreach('firewall', 'forwarding', function(s) {
				if (s['src'] == 'lan' && s['dest'] == 'tailscale') fwd_lan_to_ts = true;
				if (s['src'] == 'tailscale' && s['dest'] == 'lan') fwd_ts_to_lan = true;
			});

			if (ts_zone_section == null) {
				let zid = uci.add('firewall', 'zone');
				uci.set('firewall', zid, 'name', 'tailscale');
				uci.set('firewall', zid, 'input', 'ACCEPT');
				uci.set('firewall', zid, 'output', 'ACCEPT');
				uci.set('firewall', zid, 'forward', 'ACCEPT');
				uci.set('firewall', zid, 'masq', '1');
				uci.set('firewall', zid, 'mtu_fix', '1');
				uci.set('firewall', zid, 'network', ['tailscale']);
				changed_firewall = true;
			} else {
				let nets = uci.get('firewall', ts_zone_section, 'network');
				let net_list = [];
				let has_ts_net = false;

				if (type(nets) == 'array') {
					net_list = nets;
				} else if (type(nets) == 'string') {
					net_list = [nets];
				}

				// check if 'tailscale' is already in the list
				for (let n in net_list) {
					if (n == 'tailscale') {
						has_ts_net = true;
						break;
					}
				}

				if (!has_ts_net) {
					push(net_list, 'tailscale');
					uci.set('firewall', ts_zone_section, 'network', net_list);
					changed_firewall = true;
				}
			}

			// 3. config Forwarding
			if (!fwd_lan_to_ts) {
				let fid = uci.add('firewall', 'forwarding');
				uci.set('firewall', fid, 'src', 'lan');
				uci.set('firewall', fid, 'dest', 'tailscale');
				changed_firewall = true;
			}

			if (!fwd_ts_to_lan) {
				let fid = uci.add('firewall', 'forwarding');
				uci.set('firewall', fid, 'src', 'tailscale');
				uci.set('firewall', fid, 'dest', 'lan');
				changed_firewall = true;
			}

			// Exit node requires WAN <- tailscale forwarding
			let fwd_ts_to_wan = false;
			uci.foreach('firewall', 'forwarding', function(s) {
				if (s['src'] == 'tailscale' && s['dest'] == 'wan') fwd_ts_to_wan = true;
			});

			if (!fwd_ts_to_wan) {
				let fid = uci.add('firewall', 'forwarding');
				uci.set('firewall', fid, 'src', 'tailscale');
				uci.set('firewall', fid, 'dest', 'wan');
				changed_firewall = true;
			}

			// 4. Add explicit masquerade rule for subnet routing (tailscale -> LAN)
			// Zone-level masq '1' only applies to outgoing traffic (oifname direction)
			// For traffic forwarded from tailscale to LAN, we need explicit SNAT
			const firewall_user_path = '/etc/firewall.user';
			let lan_device = get_lan_device();

			// Determine firewall backend (nftables or iptables)
			let fw_mode = uci.get('tailscale', 'settings', 'fw_mode') || 'nftables';
			let masq_rule = '';

			if (fw_mode === 'iptables') {
				masq_rule = 'iptables -t nat -A POSTROUTING -i tailscale0 -o ' + lan_device + ' -j MASQUERADE';
			} else {
				masq_rule = 'nft add rule inet fw4 srcnat iifname tailscale0 oifname ' + lan_device + ' meta nfproto ipv4 masquerade';
			}

			// Apply rule immediately if missing
			let check_cmd = fw_mode === 'iptables'
				? 'iptables -t nat -C POSTROUTING -i tailscale0 -o ' + lan_device + ' -j MASQUERADE 2>/dev/null'
				: 'nft list chain inet fw4 srcnat 2>/dev/null | grep -q "iifname.*tailscale0.*oifname.*' + lan_device + '.*masquerade"';
			let check_result = exec(check_cmd);
			if (check_result.code != 0) {
				exec(masq_rule);
			}

			// Persist: rewrite firewall.user idempotently. Strip any existing
			// tailscale0 masquerade lines (handles lan_device renames and stale entries),
			// then append the current rule.
			let existing = access(firewall_user_path) ? readfile(firewall_user_path) || '' : '';
			let kept_lines = [];
			for (let line in split(existing, '\n')) {
				if (index(line, 'tailscale0') != -1 &&
					(index(line, 'masquerade') != -1 || index(line, 'MASQUERADE') != -1)) {
					continue;
				}
				push(kept_lines, line);
			}
			let new_content = rtrim(join('\n', kept_lines));
			if (new_content != '') new_content += '\n';
			new_content += masq_rule + '\n';
			writefile(firewall_user_path, new_content);

			// 5. Enable IP forwarding for subnet routing and exit node
			// Tailscale 1.96+ reports IP forwarding health warnings
			exec('sysctl -w net.ipv4.ip_forward=1');
			exec('sysctl -w net.ipv6.conf.all.forwarding=1');

			// 6. Set src_valid_mark for reverse path filtering (Tailscale 1.96+)
			// This prevents packets from being dropped by reverse path filtering
			// when using connmark firewall rules
			exec('sysctl -w net.ipv4.conf.all.src_valid_mark=1');

			// Persist sysctl settings
			let sysctl_conf_path = '/etc/sysctl.d/99-tailscale.conf';
			let sysctl_content = 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1\nnet.ipv4.conf.all.src_valid_mark=1\n';
			writefile(sysctl_conf_path, sysctl_content);

			// 7. save
			if (changed_network) {
				uci.save('network');
				uci.commit('network');
				exec('/etc/init.d/network reload');
			}

			if (changed_firewall) {
				uci.save('firewall');
				uci.commit('firewall');
				exec('/etc/init.d/firewall reload');
			}

			return {
				success: true,
				changed_network: changed_network,
				changed_firewall: changed_firewall,
				message: (changed_network || changed_firewall) ? 'Tailscale firewall/interface configuration applied.' : 'Tailscale firewall/interface already configured.'
			};

		} catch (e) {
			return { error: 'Exception in setup_firewall: ' + e + '\nStack: ' + (e.stacktrace || '') };
		}
	}
};

return { 'tailscale': methods };
