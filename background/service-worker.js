const SCAN_STATE = {
  isScanning: false,
  isPaused: false,
  results: [],
  liveResults: [],
  deadResults: [],
  domain: '',
  progress: 0,
  phase: '',
  startTime: null,
  scanId: null,
  options: {
    enableCT: true,
    enableCertspotter: true,
    enableBruteforce: false,
    bruteforceSize: 100,
    checkLive: true,
    concurrency: 10
  }
};

let abortController = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {
    case 'START_SCAN':
      startScan(request.domain, request.options)
        .then(results => sendResponse({ success: true, results }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_SCAN':
      stopScan();
      sendResponse({ success: true });
      return true;

    case 'GET_STATE':
      sendResponse(getState());
      return true;

    case 'GET_RESULTS':
      sendResponse({ 
        results: SCAN_STATE.results,
        liveResults: SCAN_STATE.liveResults,
        deadResults: SCAN_STATE.deadResults 
      });
      return true;

    case 'GET_OPTIONS':
      chrome.storage.local.get(['scanOptions'], (data) => {
        sendResponse(data.scanOptions || SCAN_STATE.options);
      });
      return true;

    case 'SET_OPTIONS':
      chrome.storage.local.set({ scanOptions: request.options }, () => {
        Object.assign(SCAN_STATE.options, request.options);
        sendResponse({ success: true });
      });
      return true;

    case 'OPEN_SIDEPANEL':
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.open({ tabId: tabs[0].id }, (err) => {
              if (chrome.runtime.lastError) {
                console.error('SidePanel error:', chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                sendResponse({ success: true });
              }
            });
          } else {
            sendResponse({ success: false, error: 'No active tab' });
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;

    case 'CLEAR_RESULTS':
      clearResults();
      sendResponse({ success: true });
      return true;
  }
});

function getState() {
  return {
    isScanning: SCAN_STATE.isScanning,
    isPaused: SCAN_STATE.isPaused,
    results: SCAN_STATE.results,
    liveResults: SCAN_STATE.liveResults,
    deadResults: SCAN_STATE.deadResults,
    domain: SCAN_STATE.domain,
    progress: SCAN_STATE.progress,
    phase: SCAN_STATE.phase,
    elapsed: SCAN_STATE.startTime ? Date.now() - SCAN_STATE.startTime : 0
  };
}

async function startScan(domain, options = {}) {
  if (SCAN_STATE.isScanning) {
    throw new Error('Scan already in progress');
  }

  clearResults();
  SCAN_STATE.domain = domain;
  SCAN_STATE.scanId = generateId();
  SCAN_STATE.startTime = Date.now();
  SCAN_STATE.isScanning = true;
  SCAN_STATE.isPaused = false;
  SCAN_STATE.options = { ...SCAN_STATE.options, ...options };

  abortController = new AbortController();

  try {
    const results = [];

    if (SCAN_STATE.options.enableCT) {
      SCAN_STATE.phase = 'Fetching crt.sh...';
      broadcastState();
      const ctResults = await fetchFromCrtSh(domain);
      results.push(...ctResults);

      SCAN_STATE.phase = 'Checking Certspotter...';
      broadcastState();
      const certspotterResults = await fetchFromCertspotter(domain);
      results.push(...certspotterResults);

      SCAN_STATE.phase = 'Checking Subdomain Center...';
      broadcastState();
      const subdomainCenterResults = await fetchFromSubdomainCenter(domain);
      results.push(...subdomainCenterResults);
    }

    if (SCAN_STATE.options.enableBruteforce) {
      SCAN_STATE.phase = 'Brute-forcing subdomains...';
      broadcastState();
      const bruteforceResults = await bruteforceSubdomains(domain, SCAN_STATE.options.bruteforceSize);
      results.push(...bruteforceResults);
    }

    SCAN_STATE.results = [...new Set(results)].sort();

    if (SCAN_STATE.options.checkLive && SCAN_STATE.results.length > 0) {
      SCAN_STATE.phase = 'Checking live status...';
      broadcastState();
      await checkLiveStatus();
    }

    SCAN_STATE.phase = 'Scan complete';
    SCAN_STATE.progress = 100;
    broadcastState();

    await saveResults();

    return {
      results: SCAN_STATE.results,
      liveResults: SCAN_STATE.liveResults,
      deadResults: SCAN_STATE.deadResults,
      totalFound: SCAN_STATE.results.length,
      liveCount: SCAN_STATE.liveResults.length
    };

  } catch (err) {
    if (err.name === 'AbortError') {
      SCAN_STATE.phase = 'Scan cancelled';
    } else {
      SCAN_STATE.phase = `Error: ${err.message}`;
    }
    throw err;
  } finally {
    SCAN_STATE.isScanning = false;
    abortController = null;
  }
}

function stopScan() {
  if (abortController) {
    abortController.abort();
  }
  SCAN_STATE.isScanning = false;
  SCAN_STATE.isPaused = true;
  SCAN_STATE.phase = 'Scan stopped';
  broadcastState();
}

function clearResults() {
  SCAN_STATE.results = [];
  SCAN_STATE.liveResults = [];
  SCAN_STATE.deadResults = [];
  SCAN_STATE.progress = 0;
  SCAN_STATE.phase = '';
  chrome.storage.local.remove(['lastScanResults', 'lastScanDomain']);
}

async function fetchFromCrtSh(domain) {
  const subdomains = new Set();
  
  const urls = [
    `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`,
    `https://api.corsproxy.io/?url=${encodeURIComponent(`https://crt.sh/?q=%25.${domain}&output=json`)}`
  ];

  for (const url of urls) {
    try {
      const response = await fetchWithRetry(url, 5, 3000);
      const text = await response.text();
      
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = [];
      }

      for (const entry of data) {
        const names = entry.name_value.split('\n');
        for (const name of names) {
          const trimmed = name.trim().toLowerCase();
          if (trimmed && (trimmed.endsWith(domain) || trimmed === domain)) {
            subdomains.add(trimmed);
          }
        }
      }
      
      if (subdomains.size > 0) break;
    } catch (err) {
      console.error(`crt.sh fetch error (${url}):`, err.message);
    }
  }

  await sleep(1000);
  return [...subdomains];
}

async function fetchFromCertspotter(domain) {
  const subdomains = new Set();

  const urls = [
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&match_wildcards=true&expand=dns_names`,
    `https://api.corsproxy.io/?url=${encodeURIComponent(`https://api.certspotter.com/v1/issuances?domain=${domain}&include_subdomains=true&match_wildcards=true&expand=dns_names`)}`
  ];

  for (const url of urls) {
    try {
      const response = await fetchWithRetry(url, 5, 2000);
      const data = await response.json();

      for (const cert of data) {
        if (cert.dns_names) {
          for (const name of cert.dns_names) {
            const trimmed = name.trim().toLowerCase();
            if (trimmed && (trimmed.endsWith(domain) || trimmed === domain)) {
              subdomains.add(trimmed);
            }
          }
        }
      }
      
      if (subdomains.size > 0) break;
    } catch (err) {
      console.error(`Certspotter fetch error (${url}):`, err.message);
    }
  }

  await sleep(500);
  return [...subdomains];
}

async function fetchFromSubdomainCenter(domain) {
  const subdomains = new Set();
  
  try {
    const url = `https://api.subdomain.center/?domain=${encodeURIComponent(domain)}`;
    const response = await fetchWithRetry(url, 5, 2000);
    const data = await response.json();

    if (Array.isArray(data)) {
      for (const subdomain of data) {
        const trimmed = subdomain.trim().toLowerCase();
        if (trimmed && (trimmed.endsWith(domain) || trimmed === domain)) {
          subdomains.add(trimmed);
        }
      }
    }
  } catch (err) {
    console.error('SubdomainCenter fetch error:', err.message);
  }

  await sleep(500);
  return [...subdomains];
}

async function bruteforceSubdomains(domain, size = 100) {
  const wordlist = getWordlist(size);
  const results = [];
  const batchSize = SCAN_STATE.options.concurrency;

  for (let i = 0; i < wordlist.length; i += batchSize) {
    if (abortController?.signal.aborted) break;

    const batch = wordlist.slice(i, i + batchSize);
    const batchPromises = batch.map(async (word) => {
      const subdomain = `${word}.${domain}`;
      const isLive = await checkDnsLive(subdomain);
      return isLive ? subdomain : null;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults.filter(Boolean));

    SCAN_STATE.progress = Math.round((i / wordlist.length) * 100);
    SCAN_STATE.phase = `Brute-forcing: ${i + batch.length}/${wordlist.length}`;
    broadcastState();
  }

  return results;
}

async function checkLiveStatus() {
  const subdomains = [...SCAN_STATE.results];
  const total = subdomains.length;
  
  for (let i = 0; i < subdomains.length; i++) {
    if (abortController?.signal.aborted) break;

    const subdomain = subdomains[i];
    const isLive = await checkDnsLive(subdomain);

    if (isLive) {
      if (!SCAN_STATE.liveResults.includes(subdomain)) {
        SCAN_STATE.liveResults.push(subdomain);
      }
    } else {
      if (!SCAN_STATE.deadResults.includes(subdomain)) {
        SCAN_STATE.deadResults.push(subdomain);
      }
    }

    SCAN_STATE.progress = Math.round(((i + 1) / total) * 100);
    SCAN_STATE.phase = `Checking live: ${i + 1}/${total}`;
    broadcastState();
  }

  SCAN_STATE.liveResults.sort();
  SCAN_STATE.deadResults.sort();
}

async function checkDnsLive(subdomain) {
  try {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(subdomain)}&type=A&cd=false`;
    const response = await fetch(url, { signal: abortController?.signal });
    
    if (!response.ok) return false;

    const data = await response.json();
    return data.Status === 0 && data.Answer && data.Answer.length > 0;
  } catch {
    return false;
  }
}

async function checkHttpsLive(subdomain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(`https://${subdomain}`, {
      signal: controller.signal,
      mode: 'no-cors'
    });
    
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithRetry(url, retries = 5, baseDelay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { signal: abortController?.signal });
      
      if (response.status === 429 || response.status === 502 || response.status === 503) {
        const delay = baseDelay * Math.pow(2, i);
        await sleep(delay);
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(baseDelay * (i + 1));
    }
  }
  throw new Error('Max retries exceeded');
}

async function saveResults() {
  await chrome.storage.local.set({
    lastScanResults: {
      domain: SCAN_STATE.domain,
      results: SCAN_STATE.results,
      liveResults: SCAN_STATE.liveResults,
      deadResults: SCAN_STATE.deadResults,
      timestamp: Date.now()
    }
  });
}

function broadcastState() {
  chrome.storage.local.set({ scanState: getState() });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getWordlist(size = 100) {
  const all = [
    'www', 'mail', 'ftp', 'localhost', 'webmail', 'smtp', 'pop', 'ns1', 'dns2', 'admin',
    'forum', 'news', 'vote', 'cpanel', 'whm', 'autodiscover', 'autoconfig', 'm', 'imap',
    'test', 'ns', 'pop3', 'dev', 'www2', 'app', 'help', 'shop', 'store', 'blog', 'primary',
    'mail2', 'new', 'my', 'mobile', 'msoid', 'video', 'secure', 'email', 'recovery',
    'password', 'intranet', 'portal', 'private', 'database', 'panel', 'support', 'redirect',
    'mx', 'mx1', 'mx2', 'server', 'ns2', 'web', 'status', 'api', 'api1', 'api2', 'vpn',
    'firewall', 'sip', 'ldap', 'chat', 'calendar', 'wiki', 'webdisk', 'ns3', 'backup',
    'mobile1', 'staging', 'dev1', 'www1', 'prod', 'aws', 'cloud', 'dashboard', 'git',
    'lab', 'gitlab', 'beta', 'old', 'img', 'static', 'cdn', 'assets', 'files', 'img1',
    'img2', 'test1', 'ns4', 'ns5', 'mail1', 'sql', 'mysql', 'mariadb', 'postgresql',
    'pgadmin', 'redis', 'mongo', 'mongodb', 'elasticsearch', 'kibana', 'grafana', 'prometheus',
    'jenkins', 'ci', 'cd', 'pipeline', 'deploy', 'uat', 'qa', 'stage', 'staging2',
    'preprod', 'demo', 'sandbox', 'dev2', 'dev3', 'test2', 'test3', 'db', 'database1',
    'oracle', 'mssql', 'pg', 'rabbitmq', 'kafka', 'zookeeper', 'consul', 'vault', 'nomad',
    'packer', 'terraform', 'ansible', 'chef', 'puppet', 'kubernetes', 'k8s', 'eks', 'gke',
    'aks', 'docker', 'container', 'registry', 'harbor', 'nexus', 'artifactory', 'jFrog',
    's3', 'blob', 'storage', 'backup1', 'backups', 'archive', 'logs', 'log', 'elk',
    'splunk', 'sumologic', 'newrelic', 'datadog', 'sentry', 'bugsnag', 'rollbar',
    'twilio', 'sendgrid', 'mailgun', 'ses', 'smtp2', 'smtp1', 'relay', 'gateway',
    'proxy', 'squid', 'nginx', 'apache', 'http', 'https', 'web1', 'web2', 'web3',
    'api3', 'api4', 'graphql', 'rest', 'soap', 'grpc', 'websocket', 'socket',
    'auth', 'auth0', 'oauth', 'sso', 'cas', 'keycloak', 'okta', 'ping', 'adfs',
    'identity', 'account', 'accounts', 'login', 'signin', 'signup', 'register', 'auth',
    'verify', 'token', 'jwt', 'session', 'webauthn', 'passport', 'clerk', 'supabase',
    'authenticate', 'secure', 'security', 'cert', 'ssl', 'tls', 'pki', 'waf', 'ddos',
    'cdn1', 'cdn2', 'fastly', 'cloudflare', 'akamai', 'imperva', 'incapsula',
    'origin', 'origin1', 'lb', 'loadbalancer', 'haproxy', 'traefik', 'envoy',
    'router', 'routing', 'gateway1', 'api-gateway', 'kong', 'tyk', 'management',
    'monitor', 'monitoring', 'alert', 'alerts', 'notification', 'notifications',
    'webhook', 'webhooks', 'callback', 'event', 'events', 'queue', 'worker',
    'jobs', 'cron', 'scheduler', 'celery', 'rq', 'sidekiq', 'bull', 'agenda',
    'task', 'tasks', 'async', 'background', 'worker1', 'processor', 'consumer',
    'producer', 'stream', 'streaming', 'kinesis', 'pubsub', 'amqp', 'activemq',
    'hdfs', 'hadoop', 'spark', 'flink', 'beam', 'dataflow', 'dataproc',
    'warehouse', 'dwh', 'etl', 'pipeline', 'airflow', 'dbt', 'snowflake', 'bigquery',
    'redshift', 'athena', 'synapse', 'databricks', 'starburst', 'trino', 'presto',
    'tableau', 'looker', 'metabase', 'superset', 'redash', 'growth', 'analytics',
    'metrics', 'telemetry', 'opentelemetry', 'tracing', 'zipkin', 'jaeger', 'tempo',
    'loki', 'prometheus', 'alertmanager', 'grafana', 'kibana', 'sense', 'devtools',
    'studio', 'workbench', 'query', 'console', 'terminal', 'shell', 'ssh', 'putty',
    'winrm', 'telnet', 'vnc', 'rdp', 'x11', 'x11vnc', 'nomachine', 'anydesk',
    'remote', 'remote-desktop', 'citrix', 'xenapp', 'vmware', 'esxi', 'vsphere',
    'hyperv', 'proxmox', 'ovirt', 'rancher', 'portainer', 'traefik', 'caddy',
    'envoy', 'istio', 'linkerd', 'maesh', 'osm', 'service-mesh', 'mesh',
    'ingress', 'ingress-controller', 'nginx-ingress', 'ambassador', 'gloo',
    'api-management', 'apigee', 'aws-api-gateway', 'azure-api-management', 'google-apigee',
    'kong', 'tyk', '3scale', 'gelato', 'moesif', 'mashery', 'apimatic',
    'transform', 'transformer', 'mapper', 'converter', 'parser', 'encoder', 'decoder',
    'validator', 'schema', 'json', 'xml', 'protobuf', 'avro', 'thrift',
    'rpc', 'json-rpc', 'xml-rpc', 'rest-api', 'restful', 'graphql-api',
    'graphql-playground', 'graphql-editor', 'graphiql', 'altair', 'insomnia',
    'postman', 'swagger', 'openapi', 'raml', 'api-docs', 'docs', 'documentation',
    'developer', 'developers', 'portal', 'devportal', 'apidev', 'sdk', 'client',
    'library', 'package', 'npm', 'pypi', 'maven', 'nuget', 'gem', 'cargo',
    'repo', 'repository', 'repos', 'packages', 'artifacts', 'nexus', 'jfrog',
    'npmjs', 'pypi', 'dockerhub', 'ghcr', 'gcr', 'ecr', 'acr',
    'registry', 'registries', 'images', 'containers', 'container-registry',
    'mirror', 'mirrors', 'cache', 'caches', 'caching', 'varnish', 'squid',
    'optimization', 'optimiser', 'perf', 'performance', 'speed', 'fast', 'turbo',
    'media', 'video', 'audio', 'stream', 'streaming', 'player', 'playback',
    'upload', 'uploader', 'download', 'downloader', 'transfer', 'transfer.sh',
    'share', 'sharing', 'link', 'shorturl', 'short', 'redirect', 'forward',
    'proxy', 'proxies', 'reverse', 'tunnel', 'ngrok', 'localtunnel', 'bore',
    'frp', 'sish', 'sshx', 'run', 'localhost.run', 'serveo', 'pagekite',
    'tunnel', 'tunneling', 'vpn', 'wireguard', 'openvpn', 'ipsec', 'pptp',
    'l2tp', 'ikev2', 'softether', 'zerotier', 'tailscale', 'netbird',
    'network', 'networking', 'vpc', 'subnet', 'subnets', 'cidr', 'range',
    'dhcp', 'dns', 'resolver', 'recursor', 'forwarder', 'server', 'servers',
    'host', 'hosts', 'hostname', 'ping', 'traceroute', 'mtr', 'trace',
    'diagnostics', 'diagnostic', 'debug', 'debugger', 'devenv', 'development',
    'test', 'testing', 'qa', 'quality', 'assurance', 'uat', 'preprod', 'staging',
    'production', 'prod', 'live', 'production', 'primary', 'main', 'master',
    'slave', 'replica', 'replication', 'failover', 'standby', 'hot', 'warm', 'cold',
    'primary', 'secondary', 'tertiary', 'dr', 'disaster', 'backup', 'DR', 'BCP',
    'business', 'continuity', 'disaster-recovery', 'DRaaS', 'BaaS', 'backup',
    'snapshots', 'snapshot', 'ami', 'image', 'images', 'golden', 'base',
    'template', 'templates', 'blueprint', 'configuration', 'config', 'configs',
    'settings', 'preferences', 'prefs', 'options', 'parameters', 'params',
    'environment', 'env', 'environments', 'stages', 'variables', 'secrets',
    'credentials', 'certs', 'certificates', 'keys', 'tokens', 'api-keys',
    'secret', 'secrets', 'vault', 'vaults', 'keyvault', 'key-vault', 'secrets-manager',
    'parameter-store', 'systems-manager', ' Secrets Manager', 'HashiCorp',
    'runner', 'runners', 'executors', 'executors', 'agents', 'worker', 'workers',
    'builder', 'builders', 'compile', 'compiler', 'build', 'builds', 'make',
    'cmake', 'gradle', 'maven', 'ant', 'bazel', 'buck', 'pants', 'please',
    'compiler', 'transpiler', 'bundler', 'bundles', 'bundle', 'webpack', 'rollup',
    'vite', 'esbuild', 'parcel', 'turbo', 'turborepo', 'nx', 'lerna',
    'package', 'packages', 'packager', 'packaging', 'pack', 'zip', 'tar', 'gz',
    'compress', 'compressed', 'archive', 'archives', 'archived', 'archival',
    'extractor', 'extract', 'unpack', 'unpacker', 'installer', 'install',
    'deploy', 'deploys', 'deployment', 'deployments', 'deployer', 'ship',
    'shipper', 'shipping', 'release', 'releases', 'launch', 'launcher',
    'rollback', 'rollbacks', 'revert', 'reverts', 'undo', 'undo', 'history',
    'version', 'versions', 'versioning', 'vcs', 'revision', 'revisions',
    'git', 'gitlab', 'github', 'bitbucket', 'gitea', 'gogs', 'source',
    'source-control', 'scm', 'vcs', 'mercurial', 'svn', 'cvs', 'darcs',
    'branch', 'branches', 'feature', 'features', 'feature-branch', 'feature-branches',
    'hotfix', 'hotfixes', 'patch', 'patches', 'bugfix', 'bugfixes',
    'pr', 'pull-request', 'pullrequests', 'merge', 'merges', 'merge-requests',
    'review', 'reviews', 'code-review', 'code-reviews', 'lgtm', 'approved',
    'CI', 'CD', 'ci', 'cd', 'pipeline', 'pipelines', 'workflow', 'workflows',
    'buildkite', 'circleci', 'travis', 'github-actions', 'gitlab-ci', 'jenkins',
    'teamcity', 'bamboo', 'concourse', 'gocd', 'spinnaker', 'argo', 'tekton',
    'automation', 'automated', 'automated-testing', 'testing', 'tests',
    'unit', 'units', 'unittest', 'unittests', 'integration', 'integrations',
    'e2e', 'endtoend', 'end-to-end', 'browser', 'selenium', 'playwright',
    'cypress', 'puppeteer', 'nightwatch', 'webdriver', 'appium', 'detox',
    'coverage', 'codecoverage', 'code-coverage', 'test-coverage', 'istanbul',
    'nyc', 'jacoco', 'cobertura', 'gcov', 'llvm-cov', 'codecov', 'coveralls',
    'static', 'analysis', 'code-analysis', 'static-analysis', 'lint', 'linter',
    'eslint', 'pylint', 'golint', 'rustc', 'clippy', 'sonarqube', 'sonarqube',
    'codeclimate', 'code-climate', 'bettercodehub', 'lgtm', 'deepcode',
    'snyk', 'snyk', 'whitesource', 'dependabot', 'renovate', 'greenkeeper',
    'security', 'secrets-scanning', 'secret-scanning', 'trivy', 'grype',
    'falco', ' Clair', 'clair', 'anchore', 'syft', 'docker-bench',
    'infraci', 'infracost', 'terragrunt', 'terrascan', 'checkov', 'driftctl',
    'OPA', 'opa', 'open-policy-agent', 'kyverno', 'falco', 'falcosecurity',
    'compliance', 'pci', 'pci-dss', 'hipaa', 'gdpr', 'soc2', 'iso27001',
    'audit', 'auditing', 'logs', 'logging', 'syslog', 'rsyslog', 'fluentd',
    'fluentbit', 'logstash', 'filebeat', 'journalbeat', 'metricbeat', 'heartbeat',
    'elasticsearch', 'opensearch', 'kibana', 'opensearch-dashboards', 'grafana',
    'datadog', 'newrelic', 'appdynamics', 'dynatrace', 'instana', '南部',
    'wavefront', 'signalfx', 'honeycomb', 'lightstep', 'opentelemetry',
    'otel', 'jaeger', 'zipkin', 'tempo', 'loki', 'prometheus', 'mimir',
    'cortex', 'thanos', 'victoria-metrics', 'timeseries', 'tsdb',
    'graphite', 'grafite', 'influxdb', 'influx', 'timescaledb', 'questdb',
    'clickhouse', 'pinot', 'druid', 'kylin', 'doris', 'starrocks', 'selectdb',
    'trino', 'presto', 'prestodb', 'aws-athena', 's3-select', 'redshift',
    'spectrum', 'snowflake', 'bigquery', 'bigquerystorage', 'dataproc',
    'datapipeline', 'dataflow', 'beam', 'apache-beam', 'airflow', 'mwaa',
    'astronomer', 'prefect', 'mageai', 'dagster', 'covalent', 'flyte',
    'kedro', 'metaflow', 'flyte', 'horizon', 'luigi', 'cascading', 'oozie',
    'azkaban', 'pinball', 'airflow', 'chronos', 'marathon', 'aurora',
    'mesos', 'mesosphere', 'dcos', 'marathon', 'metronome', 'jenkins-x',
    'tekton', 'pipeline', 'pipelines', 'argocd', 'argo', 'flux', 'fluxcd',
    'flagger', 'argo-rollouts', 'rollouts', 'progressive', 'canary',
    'ab-testing', 'experiments', 'experimentation', 'feature-flags', 'flags',
    'launchdarkly', 'split', 'optimizely', 'statsig', 'unleash', 'flagsmith',
    'growth', 'analytics', 'mixpanel', 'amplitude', 'segment', 'mparticle',
    'braze', 'clevertap', 'iterable', 'customer.io', 'sendgrid', 'mailgun',
    'postmark', 'sparkpost', 'mailchimp', 'campaign', 'campaigns', 'marketing',
    'email', 'notifications', 'push', 'fcm', 'apns', 'one-signal', 'airship',
    'batch', 'sms', 'twilio', 'nexmo', 'vonage', 'messagebird', 'plivo',
    'whatsapp', 'messenger', 'telegram', 'slack', 'discord', 'teams',
    'webex', 'zoom', 'gotomeeting', 'meet', 'hangouts', 'voice', 'voip',
    'video-conferencing', 'conferencing', 'meetings', 'webinar', 'webinars',
    'contact', 'contact-center', 'call', 'calling', 'contact-center-as-a-service',
    'ccas', 'genesys', 'twilio-flex', 'talkdesk', 'five9', 'nice-incontact',
    'backup', 'backups', 'archival', 'archive', 'archives', 'archiving',
    'DR', 'BC', 'disaster-recovery', 'business-continuity', 'HA', 'high-availability',
    'failover', 'failover', 'failback', 'switchover', 'cutover',
    'migration', 'migrations', ' migrate', ' migrate', 'lift-and-shift',
    'replatform', 'refactor', 'rearchitect', 're-architect', 'modernization',
    'cloudnative', 'cloud-native', 'containerization', 'containerized',
    'microservices', 'micro-services', 'service-mesh', 'service-mesh',
    'service', 'services', 'micro', 'nanoservices', 'nanoservices',
    'serverless', 'functions', 'lambda', 'azure-functions', 'gcp-functions',
    'cloudfunctions', 'openwhisk', 'knative', 'serverless-framework',
    'sam', 'serverless-application-model', 'chalice', 'zappa', 'flask',
    'express', 'fastify', 'koa', 'hapi', 'nestjs', 'spring', 'springboot',
    'django', 'flask', 'fastapi', 'pyramid', 'tornado', 'bottle',
    'rails', 'ruby', 'sinatra', 'hanami', 'rodak', 'cuba', 'lotusr',
    'laravel', 'symfony', 'cake', 'codeigniter', 'yii', 'fuel', 'slim',
    'go', 'golang', 'echo', 'gin', 'fasthttp', 'chi', 'gorilla', 'mux',
    'rust', 'actix', 'axum', 'warp', 'rocket', 'nickel', 'iron',
    'java', 'spring', 'springboot', 'micronaut', 'quarkus', 'vertx',
    'kotlin', 'scala', 'play', 'lift', 'akka', 'finagle', 'finatra',
    'node', 'nodejs', 'deno', 'bun', 'express', 'nest', 'loopback',
    'python', 'fastapi', 'flask', 'django', 'bottle', 'tornado', 'pyramid',
    'c#', 'csharp', '.net', 'dotnet', 'aspnet', 'asp.net', 'netcore',
    'mono', 'xamarin', 'unity', 'blazor', ' MAUI', 'maui', 'wpf', 'winforms',
    'php', 'laravel', 'symfony', 'codeigniter', 'zend', 'yii', 'slim',
    'ruby', 'rails', 'sinatra', 'hanami', 'grape', 'roda', 'cuba',
    'go', 'golang', 'echo', 'gin', 'fiber', 'chi', 'gorilla', 'mux',
    'typescript', 'ts', 'javascript', 'js', 'node', 'nodejs', 'deno', 'bun',
    'swift', 'swift', 'swiftui', 'icloud', 'app-store', 'appstore',
    'android', 'play-store', 'playstore', 'gcp', 'google-cloud', 'googlecloud',
    'aws', 'amazon-web-services', 'amazonwebservices', 'azure', 'microsoft-azure',
    'digitalocean', 'do', 'linode', 'vultr', 'ovh', 'hetzner', 'scaleway',
    'heroku', 'netlify', 'vercel', 'render', ' Railway', 'railway', 'fly.io',
    'cyclic', 'render', 'engineyard', 'elasticbeanstalk', 'beanstalk',
    'gke', 'google-kubernetes-engine', 'eks', 'elastic-kubernetes-service',
    'aks', 'azure-kubernetes-service', 'rke', 'rancher-kubernetes-engine',
    'ocp', 'openshift', ' OKD', 'okd', 'minikube', 'k3s', 'k3d', 'docker-desktop',
    'minishift', ' crc', 'crc', 'code-ready', 'code-ready-containers'
  ];

  return all.slice(0, size);
}
