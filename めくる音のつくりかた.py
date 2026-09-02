# 紙をめくる音を、標準ライブラリだけで作る
import math, random, struct, wave

SR = 44100
random.seed(20260902)

def biquad(kind, f0, Q, fs=SR):
    w0 = 2*math.pi*f0/fs
    c, s = math.cos(w0), math.sin(w0)
    a = s/(2*Q)
    if kind == 'bp':      # 帯域を通す（0dB ピーク）
        b0, b1, b2 = a, 0.0, -a
    elif kind == 'hp':    # 低い音を落とす
        b0, b1, b2 = (1+c)/2, -(1+c), (1+c)/2
    else:                 # 'lp' 高い音を落とす
        b0, b1, b2 = (1-c)/2, 1-c, (1-c)/2
    a0, a1, a2 = 1+a, -2*c, 1-a
    return (b0/a0, b1/a0, b2/a0, a1/a0, a2/a0)

def run(x, coeffs):
    b0,b1,b2,a1,a2 = coeffs
    y=[0.0]*len(x); x1=x2=y1=y2=0.0
    for i,v in enumerate(x):
        o = b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
        x2, x1 = x1, v
        y2, y1 = y1, o
        y[i]=o
    return y

def sweep(x, kind, f_start, f_end, Q, step=64):
    """フィルタの高さを、始めから終わりへ動かしながら通す"""
    y=[0.0]*len(x); x1=x2=y1=y2=0.0
    n=len(x); co=None
    for i,v in enumerate(x):
        if i % step == 0:
            t = i/max(1,n-1)
            f = f_start*((f_end/f_start)**t)
            co = biquad(kind, max(40.0,min(f, SR*0.45)), Q)
        b0,b1,b2,a1,a2 = co
        o = b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
        x2, x1 = x1, v
        y2, y1 = y1, o
        y[i]=o
    return y

def noise(n, texture=0.0, grain=220):
    """雑音。texture>0 で、ざらつきの濃さがゆっくり揺れる（紙のしわ感）"""
    out=[0.0]*n
    amp=1.0
    for i in range(n):
        if texture and i % grain == 0:
            amp = 1.0 - texture*random.random()
        out[i] = (random.random()*2-1)*amp
    return out

def env(n, attack, decay, curve=2.0):
    """ぱっと出て、すっと消える"""
    a=max(1,int(attack*SR)); out=[0.0]*n
    for i in range(n):
        if i < a:
            out[i]=(i/a)**0.7
        else:
            t=(i-a)/max(1,(n-a))
            out[i]=(1-t)**curve
    return out

def mix(dest, src, at):
    i0=int(at*SR)
    if len(dest) < i0+len(src): dest.extend([0.0]*(i0+len(src)-len(dest)))
    for i,v in enumerate(src): dest[i0+i]+=v
    return dest

def burst(dur, f0, f1, Q, gain, attack=0.006, curve=2.0, texture=0.0, hp=1200):
    n=int(dur*SR)
    x=noise(n, texture)
    x=run(x, biquad('hp', hp, 0.7))
    x=sweep(x, 'bp', f0, f1, Q)
    e=env(n, attack, dur, curve)
    return [v*e[i]*gain for i,v in enumerate(x)]

def norm(x, peak=0.72):
    m=max(1e-9, max(abs(v) for v in x))
    return [v/m*peak for v in x]

def save(name, x, peak=0.72):
    x=norm(x, peak)
    # 端をなめらかに（プツッという音を防ぐ）
    f=int(0.003*SR)
    for i in range(min(f,len(x))):
        x[i]*=i/f; x[-1-i]*=i/f
    w=wave.open(name,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<h', int(max(-1,min(1,v))*32767)) for v in x))
    w.close()
    print(f"{name}  {len(x)/SR:.2f}秒")

# ① かさっ（薄い紙・軽く速い）
a=[]
a=mix(a, burst(0.10, 5200, 2600, 1.1, 1.0, 0.004, 2.6, 0.35), 0.0)
a=mix(a, burst(0.08, 6400, 3400, 1.3, 0.55, 0.003, 3.0, 0.30), 0.045)
save('1_かさっ.wav', a, 0.62)

# ② ぱらっ（雑誌のつるつるした紙・歯切れよく）
b=[]
b=mix(b, burst(0.07, 7000, 4200, 1.6, 1.0, 0.002, 3.4, 0.20, hp=2000), 0.0)
b=mix(b, burst(0.05, 8200, 5200, 1.8, 0.45, 0.002, 3.6, 0.18, hp=2400), 0.035)
save('2_ぱらっ.wav', b, 0.66)

# ③ ばさっ（厚手・しっかりした紙）
c=[]
c=mix(c, burst(0.26, 2200, 900, 0.8, 1.0, 0.010, 1.8, 0.45, hp=500), 0.0)
c=mix(c, burst(0.16, 3200, 1400, 1.0, 0.5, 0.006, 2.2, 0.40, hp=700), 0.07)
save('3_ばさっ.wav', c, 0.74)

# ④ すっ（そっとめくる・とても静か）
d=[]
d=mix(d, burst(0.22, 3600, 2000, 0.9, 1.0, 0.030, 1.6, 0.25, hp=1500), 0.0)
save('4_すっ.wav', d, 0.40)

# ⑤ しゃっ（勢いよくめくる・風を切る感じ）
e=[]
e=mix(e, burst(0.30, 1200, 6000, 0.55, 1.0, 0.020, 1.4, 0.30, hp=600), 0.0)
e=mix(e, burst(0.06, 7000, 3600, 1.6, 0.7, 0.002, 3.2, 0.20, hp=2200), 0.215)
save('5_しゃっ.wav', e, 0.70)
