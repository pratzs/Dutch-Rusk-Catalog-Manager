import http.server, sys
out=sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Headers","*"); self.send_header("Access-Control-Allow-Private-Network","true")
    def do_POST(self):
        n=int(self.headers.get('Content-Length',0)); d=self.rfile.read(n); open(out,'wb').write(d)
        self.send_response(200); self._cors(); self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'ok')
    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.send_header('Content-Length','0'); self.end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8765),H).serve_forever()
