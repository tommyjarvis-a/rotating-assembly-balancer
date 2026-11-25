# Independent STEP check with plain OCCT (OCP STEPControl_Reader; not the app's occt-import-js reader):
# per root shape: solids, shells (closed or open), faces, BRepCheck validity and OCCT volume / CG.
#   /path/to/venv/bin/python tools/ocp-step-check.py file.stp [expected.json]   (expected: {"name": volume_mm3, ...})
import sys, json, re
from OCP.STEPControl import STEPControl_Reader
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_SHELL, TopAbs_FACE
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.BRep import BRep_Tool
def count(s, t):
    e = TopExp_Explorer(s, t); n = 0
    while e.More(): n += 1; e.Next()
    return n
path = sys.argv[1]; exp = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else {}
txt = open(path, encoding='latin1').read(); names = re.findall(r"=PRODUCT\('((?:[^']|'')*)'", txt)
r = STEPControl_Reader(); st = r.ReadFile(path); n = r.TransferRoots(); out = {'readStatus': int(st), 'roots': []}
for k in range(1, r.NbShapes() + 1):
    s = r.Shape(k); shells = []; e = TopExp_Explorer(s, TopAbs_SHELL)
    while e.More(): shells.append(bool(BRep_Tool.IsClosed_s(e.Current()))); e.Next()
    d = {'name': names[k - 1] if k - 1 < len(names) else None, 'solids': count(s, TopAbs_SOLID), 'shells': len(shells), 'closedShells': sum(shells), 'openShells': len(shells) - sum(shells), 'faces': count(s, TopAbs_FACE), 'valid': bool(BRepCheck_Analyzer(s).IsValid())}
    if d['solids']:
        g = GProp_GProps(); BRepGProp.VolumeProperties_s(s, g); c = g.CentreOfMass(); d['V'] = g.Mass(); d['c'] = [c.X(), c.Y(), c.Z()]
        if d['name'] in exp: d['dV_rel'] = d['V'] / exp[d['name']] - 1
    out['roots'].append(d)
print(json.dumps(out))
