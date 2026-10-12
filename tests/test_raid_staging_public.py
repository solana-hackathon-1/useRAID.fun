"""Public staging host contracts with an isolated real-Nginx consuming fixture."""
from pathlib import Path
import json
import ipaddress
import os
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
NGINX = 'nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236'
NODE = os.environ.get('STAGING_PROXY_TEST_IMAGE',
    'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392')


class PublicStagingComposition(unittest.TestCase):
    def test_connector_cannot_reach_database_or_receive_host_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory)
            for name in ['.env.app', '.env.web', '.env.worker']:
                (host / name).write_text('')
            result = subprocess.run(['docker', 'compose', '--project-directory', str(host),
                '-f', str(ROOT / 'compose.staging.yaml'),
                '-f', str(ROOT / 'compose.staging-public.yaml'), 'config', '--format', 'json'],
                env={**os.environ, 'STAGING_ROOT': str(host)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads(result.stdout)
            tunnel = config['services']['cloudflared']
            self.assertEqual(set(tunnel['networks']), {'public_edge'})
            self.assertEqual(tunnel['networks']['public_edge']['ipv4_address'], '172.30.101.3')
            self.assertFalse(tunnel.get('ports'))
            self.assertNotIn('/var/run/docker.sock', str(tunnel))
            self.assertNotIn('TUNNEL_TOKEN', tunnel.get('environment', {}))
            self.assertEqual(tunnel['command'][-2:],
                ['--token-file', '/run/secrets/cloudflare_tunnel_token'])
            self.assertIn('@sha256:', tunnel['image'])
            self.assertEqual(tunnel['restart'], 'unless-stopped')
            self.assertEqual(tunnel['cap_drop'], ['ALL'])
            self.assertEqual(config['services']['proxy']['networks']['public_edge']['ipv4_address'],
                '172.30.101.2')
            for name in ['db', 'web', 'worker']:
                self.assertNotIn('public_edge', config['services'][name]['networks'])
            for role in ['web', 'worker']:
                env = config['services'][role]['environment']
                self.assertEqual(env['NEXT_PUBLIC_APP_URL'], 'https://staging.useraid.fun')
                self.assertEqual(env['PAYOUT_ENABLED'], 'false')
                self.assertEqual(env['LIVE_COLLECTION_APPROVED'], 'false')
            watched = [name for name, service in config['services'].items()
                if service.get('labels', {}).get('com.centurylinklabs.watchtower.enable') == 'true']
            self.assertEqual(sorted(watched), ['web', 'worker'])


class PublicStagingProxy(unittest.TestCase):
    def test_fixture_supports_daemons_requiring_explicit_static_ip_subnets(self):
        real_run = subprocess.run
        configured = set()

        def older_daemon(args, **kwargs):
            if args[:3] == ['docker', 'network', 'create']:
                if '--subnet' in args:
                    configured.add(args[-1])
            elif args[:3] == ['docker', 'network', 'rm']:
                configured.discard(args[-1])
            elif args[:2] == ['docker', 'run'] and '--ip' in args:
                network = args[args.index('--network') + 1]
                if network not in configured:
                    return subprocess.CompletedProcess(args, 125, '',
                        'user specified IP address is supported only when connecting to '
                        'networks with user configured subnets')
            return real_run(args, **kwargs)

        # Exercise the real proxy fixture under the exact observed hosted-daemon constraint.
        with patch.object(subprocess, 'run', side_effect=older_daemon):
            self.test_real_proxy_trusts_only_connector_and_preserves_public_origin()

    def test_real_proxy_trusts_only_connector_and_preserves_public_origin(self):
        source = (ROOT / 'deploy/staging/nginx-public.conf').read_text()
        prefix = 'raid-public-contract-' + uuid.uuid4().hex[:10]
        network = prefix + '-net'
        owned = []

        def docker(*args, check=True):
            result = subprocess.run(['docker', *args], capture_output=True, text=True)
            if check:
                self.assertEqual(result.returncode, 0, result.stderr)
            return result

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'public.conf'
            docker('network', 'create', network)
            try:
                # Let Docker allocate an unused pool; unrelated host networks are preserved.
                pools = json.loads(docker('network', 'inspect', network).stdout)[0]['IPAM']['Config']
                subnet = next(ipaddress.ip_network(pool['Subnet']) for pool in pools
                    if ipaddress.ip_network(pool['Subnet']).version == 4)
                self.assertGreater(subnet.num_addresses, 6)
                # Older daemons require explicit IPAM for static --ip. Reserve the unused
                # Docker-selected pool with that form before attaching any fixture containers.
                docker('network', 'rm', network)
                docker('network', 'create', '--subnet', str(subnet), network)
                proxy_ip, trusted_ip, untrusted_ip, upstream_ip = (
                    str(subnet[index]) for index in [2, 3, 4, 5])
                # Change only synthetic peer/listen addresses, retaining all trust directives.
                source = source.replace('172.30.101.2', proxy_ip).replace(
                    '172.30.101.3', trusted_ip)
                config.write_text(source)
                config.chmod(0o644)
                upstream = prefix + '-web'
                docker('run', '-d', '--name', upstream, '--network', network, '--ip',
                    upstream_ip, '--network-alias', 'web', '--entrypoint', 'node', NODE,
                    '-e', "require('http').createServer((q,r)=>{r.setHeader('Content-Type',"
                    "'application/json');r.end(JSON.stringify(q.headers))}).listen(3000,'0.0.0.0')")
                owned.append(upstream)
                proxy = prefix + '-proxy'
                docker('run', '-d', '--name', proxy, '--network', network, '--ip',
                    proxy_ip, '-v', str(config) + ':/etc/nginx/conf.d/default.conf:ro', NGINX)
                owned.append(proxy)
                docker('exec', proxy, 'nginx', '-t')
                script = """(async()=>{
                    const http=require('http');
                    const request=host=>new Promise((resolve,reject)=>{
                        const q=http.request('http://172.30.254.2:8080/',{headers:{
                            Host:host,'CF-Connecting-IP':'203.0.113.17',
                            'X-Forwarded-For':'198.51.100.77','X-Forwarded-Proto':'http'}},r=>{
                            let text='';r.on('data',b=>text+=b);r.on('end',()=>{
                                let body=null;try{body=JSON.parse(text)}catch{}
                                resolve({status:r.statusCode,body,robots:r.headers['x-robots-tag']});
                            });
                        });q.on('error',reject);q.setTimeout(5000,()=>q.destroy(new Error('timeout')));q.end();
                    });
                    let results=[];
                    for(let host of ['staging.useraid.fun','foreign.example']){
                        let result;
                        for(let i=0;i<20;i++){
                            try {result=await request(host);break}
                            catch(e){if(i===19)throw e;await new Promise(r=>setTimeout(r,250))}
                        }
                        results.push(result);
                    }
                    console.log(JSON.stringify(results));
                })().catch(e=>{console.error(e.message);process.exit(1)})"""
                script = script.replace('172.30.254.2', proxy_ip)
                trusted = docker('run', '--rm', '--network', network, '--ip', trusted_ip,
                    '--entrypoint', 'node', NODE, '-e', script)
                results = json.loads(trusted.stdout)
                self.assertEqual(results[0]['status'], 200)
                self.assertEqual(results[0]['body']['x-forwarded-for'], '203.0.113.17')
                self.assertEqual(results[0]['body']['x-forwarded-proto'], 'https')
                self.assertEqual(results[0]['body']['host'], 'staging.useraid.fun')
                self.assertIn('noindex', results[0]['robots'])
                self.assertEqual(results[1]['status'], 421)
                untrusted = docker('run', '--rm', '--network', network, '--ip', untrusted_ip,
                    '--entrypoint', 'node', NODE, '-e', script)
                self.assertEqual([r['status'] for r in json.loads(untrusted.stdout)], [403, 403])
            finally:
                for name in reversed(owned):
                    docker('rm', '-f', name, check=False)
                docker('network', 'rm', network, check=False)


if __name__ == '__main__':
    unittest.main()
