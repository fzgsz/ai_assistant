import sqlite3
import json
import os
from datetime import datetime
from contextlib import contextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'chat.db')

client = AsyncOpenAI(
  api_key=os.getenv('DEEPSEEK_API_KEY', 'your-api-key'),
  base_url='https://api.deepseek.com'
)
MODEL = os.getenv('DEEPSEEK_MODEL', 'deepseek-chat')


# ── 数据库 ──────────────────────────────────────────────

@contextmanager
def get_db():
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  conn.execute('PRAGMA journal_mode=WAL')
  conn.execute('PRAGMA foreign_keys=ON')
  try:
    yield conn
  finally:
    conn.close()


def init_db():
  with get_db() as conn:
    conn.execute('''
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT DEFAULT '新对话',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )
    ''')
    conn.execute('''
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    ''')
    conn.commit()


# ── FastAPI ─────────────────────────────────────────────

app = FastAPI(title='AI 助手')

app.mount('/static', StaticFiles(directory=os.path.join(BASE_DIR, 'static')), name='static')


@app.on_event('startup')
def startup():
  init_db()


@app.get('/')
def index():
  from fastapi.responses import FileResponse
  return FileResponse(os.path.join(BASE_DIR, 'static', 'index.html'))


# ── 会话 API ────────────────────────────────────────────

@app.get('/api/conversations')
def list_conversations():
  with get_db() as conn:
    rows = conn.execute(
      'SELECT * FROM conversations ORDER BY updated_at DESC'
    ).fetchall()
  return [dict(r) for r in rows]


@app.post('/api/conversations')
def create_conversation():
  with get_db() as conn:
    cur = conn.execute(
      "INSERT INTO conversations (title) VALUES ('新对话')"
    )
    conn.commit()
  return {'id': cur.lastrowid}


@app.get('/api/conversations/{conv_id}')
def get_conversation(conv_id: int):
  with get_db() as conn:
    conv = conn.execute(
      'SELECT * FROM conversations WHERE id = ?', (conv_id,)
    ).fetchone()
    if not conv:
      raise HTTPException(404, '会话不存在')
    msgs = conn.execute(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC', (conv_id,)
    ).fetchall()
  return {
    'conversation': dict(conv),
    'messages': [dict(m) for m in msgs]
  }


@app.delete('/api/conversations/{conv_id}')
def delete_conversation(conv_id: int):
  with get_db() as conn:
    conn.execute('DELETE FROM conversations WHERE id = ?', (conv_id,))
    conn.commit()
  return {'ok': True}


# ── 消息回溯 ────────────────────────────────────────────

@app.post('/api/messages/{msg_id}/retry')
async def retry_message(msg_id: int, request: Request):
  """编辑消息并回溯到此位置，删除之后的所有消息"""
  body = await request.json()
  new_content = body.get('content', '')

  with get_db() as conn:
    msg = conn.execute('SELECT * FROM messages WHERE id = ?', (msg_id,)).fetchone()
    if not msg:
      raise HTTPException(404, '消息不存在')
    conv_id = msg['conversation_id']

    # 更新消息内容（编辑）
    if new_content:
      conn.execute('UPDATE messages SET content = ? WHERE id = ?', (new_content, msg_id))

    # 删除此消息之后的所有消息
    conn.execute('DELETE FROM messages WHERE conversation_id = ? AND id > ?', (conv_id, msg_id))
    conn.commit()

  return {'conversation_id': conv_id, 'message_id': msg_id}


# ── 聊天 API ────────────────────────────────────────────

@app.post('/api/chat')
async def chat(request: Request):
  body = await request.json()
  conv_id = body.get('conversation_id')
  new_message = body.get('message', '')
  model = body.get('model', MODEL)

  if not conv_id or not new_message:
    raise HTTPException(400, '缺少 conversation_id 或 message')

  # 获取历史消息
  with get_db() as conn:
    history = conn.execute(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC',
      (conv_id,)
    ).fetchall()

    # 保存用户消息
    conn.execute(
      'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
      (conv_id, 'user', new_message)
    )
    # 自动更新标题（取第一句用户输入前20字）
    first_msg = conn.execute(
      'SELECT content FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id ASC LIMIT 1',
      (conv_id, 'user')
    ).fetchone()
    title = first_msg['content'][:20] + ('...' if len(first_msg['content']) > 20 else '')
    conn.execute(
      'UPDATE conversations SET title = ?, updated_at = datetime("now","localtime") WHERE id = ?',
      (title, conv_id)
    )
    conn.commit()

  # 构建消息列表
  messages = [{'role': r['role'], 'content': r['content']} for r in history]
  messages.append({'role': 'user', 'content': new_message})

  async def generate():
    full_response = ''
    try:
      stream = await client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True
      )
      async for chunk in stream:
        delta = chunk.choices[0].delta
        if delta.content:
          full_response += delta.content
          yield f'data: {json.dumps({"content": delta.content}, ensure_ascii=False)}\n\n'

      # 保存 AI 回复
      with get_db() as conn:
        conn.execute(
          'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
          (conv_id, 'assistant', full_response)
        )
        conn.commit()

      yield f'data: {json.dumps({"done": True}, ensure_ascii=False)}\n\n'

    except Exception as e:
      yield f'data: {json.dumps({"error": str(e)}, ensure_ascii=False)}\n\n'

  return StreamingResponse(
    generate(),
    media_type='text/event-stream',
    headers={
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  )


if __name__ == '__main__':
  import uvicorn
  uvicorn.run(app, host='0.0.0.0', port=8000)
