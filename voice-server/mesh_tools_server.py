"""Mac-side mesh-tools service for the voice assistant (external mesh-client, ask-only).

The voice brain runs on the GPU box; the mesh (agents, gh, dashboard) lives on the Mac.
This loopback service executes the read/ask mesh operations where the mesh is, and the
box brain calls it over a reverse SSH tunnel (box 127.0.0.1:9100 -> here).

  GET  /agents            -> {"agents":[names]}            (from mesh.json)
  GET  /status            -> {"open_issues":n,"issues":[...],"open_prs":n,"prs":[...]}
  POST /ask {agent,question} -> {"answer": "..."}          (ask-only A2A via the dashboard)

Read-only + ask-only: it can list/read/ask, never makes agents do work.
Env: MESH_DIR, GH_REPO, DASH_URL, DASH_TOKEN_FILE.
"""
import json
import os
import subprocess
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HOME = os.path.expanduser("~")
MESH_DIR = os.environ.get("MESH_DIR", f"{HOME}/.agent-mesh/deploy/dev-mesh")
GH_REPO = os.environ.get("GH_REPO", "danabaxia/agent_mesh")
DASH_URL = os.environ.get("DASH_URL", "http://127.0.0.1:7077")
DASH_TOKEN_FILE = os.environ.get("DASH_TOKEN_FILE", f"{MESH_DIR}/.agent-mesh/dashboard-token")


def mesh_agents():
    try:
        m = json.load(open(f"{MESH_DIR}/mesh.json"))
        ags = m.get("agents", m.get("members", []))
        return [a.get("name") for a in ags if a.get("name")]
    except Exception:
        return []


def gh_json(args):
    try:
        p = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=15, cwd=MESH_DIR)
        return json.loads(p.stdout) if p.returncode == 0 and p.stdout.strip() else []
    except Exception:
        return []


_ROLE_ZH = {
    "maintainer": "维护——盯 CI、依赖、健康", "analyst": "分析——每日复盘、提想法",
    "triager": "分类——给新 issue 分诊定级", "coder": "编码——实现 spec、写代码",
    "tester": "测试——跑测试、出质量报告", "reviewer": "审查——评审 PR、把质量关",
    "curator": "整理——维护记忆和知识", "orchestrator": "协调——把任务拆给团队、统筹",
    "security": "安全——盯安全不变量、对抗测试", "concierge": "门房——手机端答主人关于 mesh 的问题",
}

def mesh_context():
    """Static-ish mesh structure for the voice brain's system prompt: who the agents
    are and what they do, so a fast LLM (Gemini) understands the mesh without spawning Claude."""
    agents = []
    for name in mesh_agents():
        role = _ROLE_ZH.get(name, "")
        if not role:
            for p in (f"{MESH_DIR}/{name}/AGENT.md", f"{MESH_DIR}/{name}/CLAUDE.md"):
                try:
                    lines = [l.strip() for l in open(p).read().splitlines() if l.strip() and not l.startswith("#")]
                    role = lines[0][:140] if lines else ""; break
                except Exception:
                    pass
        agents.append({"name": name, "role": role})
    return {
        "summary": ("这是 owner 的 dev-society 自治智能体网络:一群 agent 自主把想法变成上线代码"
                    "(idea→spec→build→PR→merge),由 GitHub issue 驱动、daemon 全天运行。"),
        "agents": agents,
    }

def mesh_status():
    issues = gh_json(["issue", "list", "--repo", GH_REPO, "--state", "open", "--limit", "8",
                      "--json", "number,title"])
    prs = gh_json(["pr", "list", "--repo", GH_REPO, "--state", "open", "--limit", "8",
                   "--json", "number,title"])
    return {
        "open_issues": len(issues),
        "issues": [{"number": i["number"], "title": i["title"]} for i in issues],
        "open_prs": len(prs),
        "prs": [{"number": p["number"], "title": p["title"]} for p in prs],
    }


def ask_agent(agent, question):
    if agent not in mesh_agents():
        return {"answer": f"(no agent named '{agent}' in the mesh)"}
    try:
        token = open(DASH_TOKEN_FILE).read().strip()
    except Exception:
        return {"answer": "(dashboard token unavailable)"}
    body = json.dumps({"text": question, "mode": "ask"}).encode()
    req = urllib.request.Request(f"{DASH_URL}/api/agent/{agent}/message", data=body, method="POST",
        headers={"content-type": "application/json", "X-Dashboard-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read())
        # extract the answer text from common shapes
        ans = d.get("answer") or d.get("reply") or d.get("text")
        if not ans and isinstance(d.get("task"), dict):
            for art in d["task"].get("artifacts", []):
                for part in art.get("parts", []):
                    if part.get("text"): ans = part["text"]; break
        return {"answer": ans or json.dumps(d)[:600]}
    except Exception as e:
        return {"answer": f"(ask failed: {str(e)[:120]})"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path == "/agents": self._send(200, {"agents": mesh_agents()})
        elif self.path == "/context": self._send(200, mesh_context())
        elif self.path == "/status": self._send(200, mesh_status())
        else: self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/ask": self._send(404, {"error": "not found"}); return
        n = int(self.headers.get("content-length", 0) or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        self._send(200, ask_agent(str(body.get("agent", "")), str(body.get("question", ""))))


def main():
    port = int(os.environ.get("MESH_TOOLS_PORT", "9100"))
    print(f"mesh-tools on 127.0.0.1:{port} (mesh={MESH_DIR}, repo={GH_REPO})", flush=True)
    print(f"agents: {mesh_agents()}", flush=True)
    HTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
