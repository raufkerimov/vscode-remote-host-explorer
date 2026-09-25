// @ts-check
/* eslint-disable */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	/** Values come from the extension as JSON data, never interpolated into markup. */
	const initial = JSON.parse(document.getElementById('initial-state').textContent);

	const byId = id => document.getElementById(id);

	const TEXT_FIELDS = [
		'name',
		'host',
		'port',
		'username',
		'privateKeyPath',
		'remoteRoot',
		'ignoreGlobs',
		'rsyncOptions',
	];
	const CHECKBOX_FIELDS = ['autoUpload', 'useRsyncForUpload', 'production'];
	// Secrets are deliberately excluded from persisted webview state so they never reach disk.
	const SECRET_FIELDS = ['password', 'passphrase'];

	const authMethodEl = byId('authMethod');
	const authMethodRow = byId('auth-method-row');
	const protocolEl = byId('protocol');
	const scopeEl = byId('scope');
	const rsyncSection = byId('rsync-section');
	const insecureWarning = byId('insecure-warning');
	const statusEl = byId('status');
	const errorEl = byId('error');
	const testButton = byId('testConnection');
	const sections = { password: byId('auth-password'), key: byId('auth-key'), agent: byId('auth-agent') };
	const mappingsEl = byId('mappings');
	const mappingTemplate = byId('mapping-template');

	// --- folder mappings --------------------------------------------------------

	function mappingRows() {
		return Array.from(mappingsEl.children);
	}

	function addMappingRow(mapping) {
		const row = mappingTemplate.content.firstElementChild.cloneNode(true);
		row.querySelector('.mapping-local').value = mapping.localPath || '';
		row.querySelector('.mapping-remote').value = mapping.remotePath || '';
		mappingsEl.appendChild(row);
		return row;
	}

	function renderMappings(mappings) {
		mappingsEl.textContent = '';
		for (const mapping of mappings) {
			addMappingRow(mapping);
		}
	}

	function currentMappings() {
		return mappingRows().map(row => ({
			localPath: row.querySelector('.mapping-local').value,
			remotePath: row.querySelector('.mapping-remote').value,
		}));
	}

	function populateProtocols() {
		protocolEl.textContent = '';
		for (const protocol of initial.protocols) {
			const option = document.createElement('option');
			option.value = protocol.value;
			option.textContent = protocol.label;
			protocolEl.appendChild(option);
		}
	}

	function configureScope() {
		const projectOption = scopeEl.querySelector('option[value="project"]');
		projectOption.disabled = !initial.projectAvailable;
		byId('scope-hint').textContent = initial.projectAvailable
			? ''
			: 'Open a folder to limit a server to one project.';
	}

	function applyValues(values) {
		for (const field of TEXT_FIELDS) {
			if (typeof values[field] === 'string') {
				byId(field).value = values[field];
			}
		}
		for (const field of CHECKBOX_FIELDS) {
			if (typeof values[field] === 'boolean') {
				byId(field).checked = values[field];
			}
		}
		if (typeof values.protocol === 'string') {
			protocolEl.value = values.protocol;
		}
		if (typeof values.authMethod === 'string') {
			authMethodEl.value = values.authMethod;
		}
		if (typeof values.scope === 'string') {
			scopeEl.value = values.scope === 'project' && !initial.projectAvailable ? 'global' : values.scope;
		}
		if (Array.isArray(values.mappings)) {
			renderMappings(values.mappings);
		}
	}

	function isSftp() {
		return protocolEl.value === 'sftp';
	}

	function currentFormPayload() {
		const payload = {
			protocol: protocolEl.value,
			// FTP has no key authentication, whatever the hidden selector still says.
			authMethod: isSftp() ? authMethodEl.value : 'password',
			scope: scopeEl.value,
			mappings: currentMappings(),
		};
		for (const field of TEXT_FIELDS) {
			payload[field] = byId(field).value;
		}
		for (const field of CHECKBOX_FIELDS) {
			payload[field] = byId(field).checked;
		}
		for (const field of SECRET_FIELDS) {
			payload[field] = byId(field).value;
		}
		return payload;
	}

	function saveRestorableState() {
		const state = currentFormPayload();
		for (const field of SECRET_FIELDS) {
			delete state[field];
		}
		vscode.setState(state);
	}

	function updateAuthSection() {
		const method = isSftp() ? authMethodEl.value : 'password';
		for (const key of Object.keys(sections)) {
			sections[key].classList.toggle('active', method === key);
		}
	}

	/** SSH-only options (key auth, rsync) disappear for FTP, and plain FTP gets an encryption warning. */
	function updateProtocolSections() {
		authMethodRow.classList.toggle('hidden', !isSftp());
		byId('importSshConfig').classList.toggle('hidden', !isSftp());
		rsyncSection.classList.toggle('active', isSftp());
		insecureWarning.classList.toggle('active', protocolEl.value === 'ftp');
		byId('port').placeholder = String(initial.defaultPorts[protocolEl.value] ?? '');
		byId('port-hint').textContent = protocolEl.value === 'ftps' ? '(optional; 990 uses implicit TLS)' : '(optional)';
		updateAuthSection();
	}

	// --- initial render -------------------------------------------------------

	populateProtocols();
	configureScope();
	byId('heading').textContent = initial.isEdit ? 'Edit Server' : initial.isDuplicate ? 'Duplicate Server' : 'Add Server';
	byId('save').textContent = initial.isEdit ? 'Save' : 'Add Server';
	const keepHint = initial.isEdit
		? '(leave blank to keep existing)'
		: initial.isDuplicate
			? "(leave blank to use the original server's)"
			: '';
	byId('password-hint').textContent = keepHint;
	byId('passphrase-hint').textContent = keepHint || '(optional)';

	applyValues(initial.values);
	// A restored state (window reload, or the tab coming back into view) wins over the stored profile.
	const restored = vscode.getState();
	if (restored) {
		applyValues(restored);
	}
	updateProtocolSections();

	// --- events ---------------------------------------------------------------

	authMethodEl.addEventListener('change', () => {
		updateAuthSection();
		saveRestorableState();
	});
	protocolEl.addEventListener('change', () => {
		updateProtocolSections();
		saveRestorableState();
	});
	scopeEl.addEventListener('change', saveRestorableState);
	for (const field of TEXT_FIELDS.concat(CHECKBOX_FIELDS)) {
		byId(field).addEventListener('input', saveRestorableState);
		byId(field).addEventListener('change', saveRestorableState);
	}

	byId('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

	byId('browsePrivateKey').addEventListener('click', () => {
		vscode.postMessage({ type: 'browsePrivateKey' });
	});
	byId('importSshConfig').addEventListener('click', () => {
		vscode.postMessage({ type: 'importSshConfig' });
	});
	byId('browseRemoteRoot').addEventListener('click', () => {
		vscode.postMessage({ type: 'browseRemotePath', payload: currentFormPayload() });
	});

	byId('addMapping').addEventListener('click', () => {
		addMappingRow({}).querySelector('.mapping-local').focus();
		saveRestorableState();
	});
	// Rows come and go, so their buttons and fields are handled by delegation, addressed by row position.
	mappingsEl.addEventListener('click', event => {
		const button = event.target instanceof Element ? event.target.closest('button') : null;
		const row = button?.closest('.mapping');
		if (!button || !row) {
			return;
		}
		const mappingIndex = mappingRows().indexOf(row);
		if (button.classList.contains('mapping-remove')) {
			row.remove();
			saveRestorableState();
		} else if (button.classList.contains('mapping-browse-local')) {
			vscode.postMessage({ type: 'browseLocalFolder', mappingIndex });
		} else if (button.classList.contains('mapping-browse-remote')) {
			vscode.postMessage({ type: 'browseRemotePath', mappingIndex, payload: currentFormPayload() });
		}
	});
	mappingsEl.addEventListener('input', saveRestorableState);

	testButton.addEventListener('click', () => {
		statusEl.textContent = 'Testing...';
		statusEl.className = 'status';
		testButton.disabled = true;
		vscode.postMessage({ type: 'testConnection', payload: currentFormPayload() });
	});

	byId('save').addEventListener('click', () => {
		vscode.postMessage({ type: 'submit', payload: currentFormPayload() });
	});

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'error') {
			errorEl.textContent = message.message;
		}
		if (message.type === 'setField') {
			errorEl.textContent = '';
			byId(message.field).value = message.value;
			saveRestorableState();
		}
		if (message.type === 'applySshHost') {
			errorEl.textContent = '';
			applyValues(message.values);
			if (!byId('name').value.trim()) {
				byId('name').value = message.suggestedName;
			}
			updateProtocolSections();
			saveRestorableState();
			statusEl.textContent = message.notice || '';
			statusEl.className = 'status';
		}
		if (message.type === 'setMappingField') {
			const row = mappingRows()[message.index];
			if (row) {
				errorEl.textContent = '';
				row.querySelector(message.key === 'localPath' ? '.mapping-local' : '.mapping-remote').value = message.value;
				saveRestorableState();
			}
		}
		if (message.type === 'testResult') {
			testButton.disabled = false;
			statusEl.textContent = message.message;
			statusEl.className = 'status ' + (message.success ? 'success' : 'failure');
		}
	});
})();
