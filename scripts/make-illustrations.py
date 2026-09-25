# Genera las ilustraciones vectoriales de la DEMO (no son fotografías del local).
# Uso: python3 scripts/make-illustrations.py
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'illus')
os.makedirs(OUT, exist_ok=True)

def svg(name, bg1, bg2, body):
    s = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" role="img" aria-label="Ilustración">
<defs><radialGradient id="bg" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="{bg1}"/><stop offset="1" stop-color="{bg2}"/></radialGradient>
<linearGradient id="bun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3b45c"/><stop offset="1" stop-color="#c97a2c"/></linearGradient>
<linearGradient id="fry" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe07a"/><stop offset="1" stop-color="#f0b429"/></linearGradient>
<linearGradient id="meat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a4a2b"/><stop offset="1" stop-color="#5a2c17"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".5" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="400" height="300" fill="url(#bg)"/>
<g opacity=".12" fill="#fff"><circle cx="40" cy="40" r="6"/><circle cx="360" cy="60" r="9"/><circle cx="330" cy="250" r="5"/><circle cx="70" cy="240" r="8"/><circle cx="200" cy="24" r="4"/></g>
<ellipse cx="200" cy="262" rx="140" ry="16" fill="#000" opacity=".18"/>
{body}
</svg>'''
    open(os.path.join(OUT, name), 'w').write(s)

# ---------- Papas fritas (3 tamaños) ----------
def fries(scale):
    n = {0.8: 7, 1.0: 9, 1.15: 11}[scale]
    w = 150 * scale; h = 120 * scale; x0 = 200 - w / 2; ytop = 262 - h
    sticks = ''
    import random
    random.seed(int(scale * 100))
    for k in range(n):
        x = x0 + 12 + k * (w - 24) / (n - 1) - 7
        ht = h * (0.75 + random.random() * 0.45)
        rot = random.uniform(-12, 12)
        sticks += f'<rect x="{x:.0f}" y="{ytop - ht*0.55:.0f}" width="14" height="{ht:.0f}" rx="3" fill="url(#fry)" stroke="#d99a1e" stroke-width="1.5" transform="rotate({rot:.1f} {x+7:.0f} {ytop+20:.0f})"/>'
    cone = f'<path d="M{x0:.0f} {ytop:.0f} L{x0+w:.0f} {ytop:.0f} L{x0+w-18*scale:.0f} 262 L{x0+18*scale:.0f} 262 Z" fill="#d7263d"/>' \
           f'<path d="M{x0:.0f} {ytop:.0f} L{x0+w:.0f} {ytop:.0f} L{x0+w-4:.0f} {ytop+22*scale:.0f} L{x0+4:.0f} {ytop+22*scale:.0f} Z" fill="#b01e31"/>' \
           f'<path d="M{200-26*scale:.0f} {ytop+60*scale:.0f} q{26*scale:.0f} {-26*scale:.0f} {52*scale:.0f} 0 q{-26*scale:.0f} {26*scale:.0f} {-52*scale:.0f} 0Z" fill="#ffd23f"/>' \
           f'<rect x="{x0+10:.0f}" y="{ytop+28*scale:.0f}" width="10" height="{h-40*scale:.0f}" fill="url(#gloss)" opacity=".6"/>'
    return sticks + cone
svg('papas-chicas.svg', '#ffe8a3', '#f7a948', fries(0.8))
svg('papas-medianas.svg', '#ffe8a3', '#f59a3a', fries(1.0))
svg('papas-grandes.svg', '#ffe8a3', '#ef8a2e', fries(1.15))

# ---------- Completos ----------
def hotdog(top):
    return f'''<g transform="translate(0,20)">
<path d="M58 170 Q200 118 342 170 Q336 142 300 130 Q200 110 100 130 Q64 142 58 170Z" fill="#e7a24f"/>
<path d="M60 170 Q200 245 340 170 Q345 215 300 232 Q200 262 100 232 Q55 215 60 170Z" fill="url(#bun)"/>
<rect x="52" y="150" width="296" height="34" rx="17" fill="#b5462a"/><rect x="60" y="154" width="280" height="8" rx="4" fill="#d9674a" opacity=".7"/>
{top}
</g>'''
tomato = ''.join(f'<rect x="{x}" y="{142 - (i%2)*5}" width="20" height="16" rx="4" fill="#e63946" stroke="#b3212f" stroke-width="1.5"/>' for i, x in enumerate(range(78, 320, 26)))
palta = f'<path d="M72 138 Q110 120 150 134 Q190 116 230 132 Q270 116 330 136 Q318 124 300 120 Q200 100 100 120 Q80 126 72 138Z" fill="#7cb342"/><path d="M80 134 Q200 106 322 132" stroke="#aed581" stroke-width="6" fill="none" stroke-linecap="round"/>'
mayo = '<path d="M80 124 q12 -14 24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0" stroke="#fffbe6" stroke-width="8" fill="none" stroke-linecap="round"/>'
svg('italiano.svg', '#fff0d6', '#f28c38', hotdog(tomato + palta + mayo))
chucrut = ''.join(f'<path d="M{x} 128 q6 -10 12 0 q6 10 12 0" stroke="#e9e3a6" stroke-width="3" fill="none"/>' for x in range(84, 300, 22))
americana = '<path d="M86 116 q16 -8 32 0 t32 0 t32 0 t32 0 t32 0 t32 0 t32 0" stroke="#f4a259" stroke-width="5" fill="none" stroke-linecap="round"/>'
svg('dinamico.svg', '#fff0d6', '#e76f51', hotdog(tomato + palta + chucrut + mayo + americana))

# ---------- Sándwiches ----------
def sandwich(extra, long=True):
    x1, x2 = (70, 330) if long else (95, 305)
    return f'''<path d="M{x1} 200 Q200 250 {x2} 200 L{x2-8} 226 Q200 262 {x1+8} 226Z" fill="url(#bun)"/>
<path d="M{x1-6} 196 Q200 214 {x2+6} 196 L{x2+2} 184 Q200 170 {x1-2} 184Z" fill="url(#meat)"/>
<path d="M{x1+6} 188 {' '.join(['q14 10 28 0'] + ['t28 0'] * int((x2 - x1 - 40) / 28))}" stroke="#7a3b1f" stroke-width="3" fill="none" opacity=".6"/>
{extra}
<path d="M{x1-4} 160 Q200 60 {x2+4} 160 Q200 150 {x1-4} 160Z" fill="url(#bun)"/>
<path d="M{x1+30} 128 Q200 80 {x2-60} 118" stroke="#fff" stroke-width="8" fill="none" opacity=".25" stroke-linecap="round"/>
{''.join(f'<ellipse cx="{x}" cy="{y}" rx="4" ry="2.5" fill="#fff4d6" transform="rotate({r} {x} {y})"/>' for x,y,r in [(150,110,20),(185,100,-10),(220,102,15),(250,112,-20),(170,124,5),(235,126,30)])}'''
layers = '<path d="M64 182 Q200 196 336 182 L336 172 Q200 158 64 172Z" fill="#e63946"/><path d="M62 172 Q110 150 160 168 Q210 148 260 166 Q300 150 338 170 Q200 150 62 172Z" fill="#7cb342"/><path d="M70 164 q10 -8 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" stroke="#fffbe6" stroke-width="6" fill="none" stroke-linecap="round"/>'
svg('ass.svg', '#fde2c4', '#c8553d', sandwich(layers))
svg('churrasco.svg', '#fde2c4', '#8c3b2a', sandwich(layers.replace('64 182', '92 182').replace('336 182', '308 182').replace('M62 172','M90 172').replace('338 170','310 170').replace('Q200 150 62 172','Q200 150 90 172').replace('M70 164','M98 164').replace(' t20 0 t20 0 t20 0" stroke="#fffbe6"','" stroke="#fffbe6"'), long=False) +
    '<g transform="translate(300 70)"><circle r="26" fill="#ffd23f"/><text y="7" text-anchor="middle" font-family="Arial Black,Arial" font-weight="900" font-size="18" fill="#6b2d12">RM</text></g>')

# ---------- Chorrillana ----------
plate = '<ellipse cx="200" cy="215" rx="160" ry="48" fill="#f7f3ea"/><ellipse cx="200" cy="208" rx="140" ry="38" fill="#e9e2d2"/>'
import random
random.seed(7)
chfries = ''.join(f'<rect x="{random.randint(90,290)}" y="{random.randint(165,205)}" width="{random.randint(40,60)}" height="11" rx="3" fill="url(#fry)" stroke="#d99a1e" transform="rotate({random.randint(-40,40)} 200 190)"/>' for _ in range(26))
chmeat = ''.join(f'<rect x="{random.randint(110,270)}" y="{random.randint(160,200)}" width="{random.randint(18,28)}" height="{random.randint(12,18)}" rx="5" fill="url(#meat)"/>' for _ in range(14))
chonion = ''.join(f'<path d="M{x} {y} q10 -8 20 0" stroke="#f1d3a1" stroke-width="4" fill="none" stroke-linecap="round"/>' for x, y in [(130,170),(170,160),(230,168),(260,182),(150,196),(210,190)])
egg = '<g transform="translate(205 168)"><path d="M-42 0 q-6 -26 20 -30 q18 -18 40 -2 q30 0 26 26 q6 22 -24 26 q-20 12 -40 0 q-26 2 -22 -20Z" fill="#fff"/><circle cx="2" cy="-4" r="15" fill="#ffb627"/><circle cx="-3" cy="-9" r="4" fill="#fff" opacity=".6"/></g>'
svg('chorrillana.svg', '#fff1d0', '#e07a2e', plate + chfries + chmeat + chonion + egg)

# ---------- Fajitas ----------
faj = '''<g transform="rotate(-8 200 190)">
<path d="M90 230 Q80 150 150 130 L300 150 Q330 210 300 240 Z" fill="#f5deb3" stroke="#d9b77f" stroke-width="3"/>
<path d="M140 150 L290 160 L285 196 L135 186Z" fill="url(#meat)"/>
<path d="M146 160 L282 168" stroke="#e63946" stroke-width="9" stroke-linecap="round"/>
<path d="M150 176 L278 184" stroke="#43a047" stroke-width="8" stroke-linecap="round"/>
<path d="M156 146 L272 154" stroke="#ffd23f" stroke-width="7" stroke-linecap="round"/>
<path d="M90 230 Q150 170 230 200 Q280 220 300 240 Q200 268 90 230Z" fill="#f3d19c" stroke="#d9b77f" stroke-width="3"/>
<g fill="#c9a064" opacity=".7"><circle cx="150" cy="226" r="4"/><circle cx="200" cy="232" r="3"/><circle cx="250" cy="236" r="4"/><circle cx="175" cy="214" r="3"/></g></g>'''
svg('fajitas.svg', '#ffe9c7', '#d1495b', faj)

# ---------- Quesadillas ----------
def wedge(cx, cy, rot):
    return f'''<g transform="translate({cx} {cy}) rotate({rot})"><path d="M0 0 L110 -30 A115 115 0 0 1 110 30Z" fill="#f2d49b" stroke="#d6ab5f" stroke-width="3"/>
<path d="M60 -16 q10 12 20 0 q10 14 20 2 q6 14 12 6 L110 30 L60 16Z" fill="#ffcf3f" opacity=".95"/>
<g fill="#b07b35" opacity=".6"><circle cx="40" cy="0" r="3"/><circle cx="75" cy="-8" r="3"/><circle cx="90" cy="12" r="3"/></g></g>'''
svg('quesadillas.svg', '#fff4d1', '#f4a261', plate + wedge(200, 205, 200) + wedge(200, 205, 250) + wedge(200, 205, 320))

# ---------- Empanaditas ----------
def emp(x, y, r):
    return f'''<g transform="translate({x} {y}) rotate({r})"><path d="M-50 10 A52 52 0 0 1 50 10 Z" fill="#e8a64e"/><path d="M-50 10 A52 52 0 0 1 50 10" fill="none" stroke="#f7c77a" stroke-width="3" opacity=".7"/>
{''.join(f'<path d="M{-50+i*10} 10 q5 6 10 0" stroke="#c07a26" stroke-width="3" fill="none"/>' for i in range(10))}
<g fill="#fbe3b0"><circle cx="-18" cy="-12" r="2.5"/><circle cx="6" cy="-24" r="2.5"/><circle cx="22" cy="-8" r="2.5"/></g></g>'''
svg('empanaditas.svg', '#fff0cf', '#e9883a', plate + emp(145, 205, -10) + emp(255, 205, 12) + emp(200, 180, 0) + '<path d="M232 170 q14 -14 26 -2 q-6 10 -20 10Z" fill="#ffd23f"/>')

# ---------- Aros de cebolla ----------
def ring(x, y, r, rot=0):
    return f'<g transform="rotate({rot} {x} {y})"><ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r*0.62}" fill="none" stroke="#c9832e" stroke-width="22"/><ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r*0.62}" fill="none" stroke="#e9a84a" stroke-width="15" stroke-dasharray="6 5"/><ellipse cx="{x}" cy="{y-3}" rx="{r-4}" ry="{r*0.55}" fill="none" stroke="#ffd98a" stroke-width="3" opacity=".6"/></g>'
svg('aros.svg', '#fff3d6', '#dd7a30', plate + ring(150, 205, 44, -8) + ring(250, 205, 46, 10) + ring(200, 170, 44, 0))

# ---------- Bebidas (genéricas, sin marcas) ----------
lata = '''<rect x="150" y="70" width="100" height="186" rx="16" fill="#2a9d8f"/><rect x="150" y="70" width="100" height="20" rx="10" fill="#b8b8b8"/><rect x="150" y="236" width="100" height="20" rx="10" fill="#9a9a9a"/>
<rect x="165" y="90" width="14" height="146" fill="url(#gloss)"/><rect x="150" y="140" width="100" height="10" fill="#ffd23f"/><rect x="150" y="156" width="100" height="30" fill="#fff" opacity=".9"/><rect x="150" y="192" width="100" height="10" fill="#ffd23f"/>
<g fill="#fff" opacity=".6"><circle cx="275" cy="120" r="5"/><circle cx="288" cy="95" r="3"/><circle cx="120" cy="140" r="4"/></g>'''
svg('lata.svg', '#dff7f3', '#1f6f66', lata)
botella = '''<path d="M182 40 h36 v26 q0 12 12 24 q22 22 22 56 v100 q0 14 -14 14 h-76 q-14 0 -14 -14 v-100 q0 -34 22 -56 q12 -12 12 -24Z" fill="#6a994e" opacity=".85"/>
<rect x="180" y="30" width="40" height="18" rx="4" fill="#386641"/><rect x="148" y="150" width="104" height="54" fill="#f4a261"/><rect x="148" y="166" width="104" height="22" fill="#fff" opacity=".85"/>
<rect x="160" y="100" width="12" height="150" fill="url(#gloss)"/>'''
svg('botella.svg', '#eef7e4', '#4f772d', botella)
agua = '''<path d="M184 42 h32 v22 q0 10 10 20 q24 24 24 60 v106 q0 14 -14 14 h-72 q-14 0 -14 -14 v-106 q0 -36 24 -60 q10 -10 10 -20Z" fill="#a8dadc" opacity=".85" stroke="#6fb6c9" stroke-width="3"/>
<rect x="182" y="30" width="36" height="16" rx="4" fill="#1d6fa3"/><rect x="150" y="150" width="100" height="48" fill="#1d6fa3"/><path d="M190 162 q10 -14 20 0 q0 14 -10 16 q-10 -2 -10 -16Z" fill="#fff"/>
<rect x="162" y="96" width="12" height="150" fill="url(#gloss)"/><path d="M152 214 q24 -8 48 0 t48 0 v36 h-96Z" fill="#6fb6c9" opacity=".4"/>'''
svg('agua.svg', '#e0f4ff', '#3a86ff', agua)
jugo = '''<path d="M150 80 L250 80 L262 256 L138 256Z" fill="#fff" opacity=".35" stroke="#fff" stroke-width="4"/>
<path d="M146 120 L254 120 L261 250 L139 250Z" fill="#f77f00"/><path d="M146 120 q27 -10 54 0 t54 0" stroke="#fcbf49" stroke-width="6" fill="none"/>
<rect x="222" y="40" width="10" height="120" rx="4" fill="#06d6a0" transform="rotate(14 227 100)"/>
<g transform="translate(262 92)"><circle r="30" fill="#ffba08"/><circle r="24" fill="#faa307"/><g stroke="#ffba08" stroke-width="3">
<line x1="0" y1="-22" x2="0" y2="22"/><line x1="-22" y1="0" x2="22" y2="0"/><line x1="-16" y1="-16" x2="16" y2="16"/><line x1="-16" y1="16" x2="16" y2="-16"/></g></g>
<rect x="156" y="126" width="12" height="118" fill="url(#gloss)"/>'''
svg('jugo.svg', '#fff4d6', '#f48c06', jugo)
print('ok', sorted(os.listdir(OUT)))
