"""Small offline smoke test. Run: python -m unittest test_smoke.py"""
import os
import tempfile
import unittest
from pathlib import Path

_TEMP = tempfile.TemporaryDirectory()
os.environ['DB_PATH'] = str(Path(_TEMP.name) / 'waterwatch-test.db')
from fastapi.testclient import TestClient
from main import app

class SmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_flow(self):
        c = self.client
        self.assertEqual(c.get('/api/health').status_code, 200)
        self.assertEqual(c.get('/api/dashboard').json()['stats']['total'], 0)
        demo = c.post('/api/demo/load')
        self.assertEqual(demo.status_code, 200)
        result = c.get('/api/dashboard').json()
        self.assertEqual(result['stats']['total'], 8)
        self.assertEqual(result['stats']['missing_location'], 1)
        self.assertEqual(len(result['clusters']), 2)
        cluster = result['clusters'][0]
        sim = c.post(f'/api/alerts/{cluster["id"]}/simulate',json=result['settings'])
        self.assertEqual(sim.status_code, 200)
        self.assertEqual(sim.json()['status'], 'simulated_only')
        new = {'client_id':'offline-1','household_id':'REAL-1','ward_id':'Ward 3',
               'test_type':'E. coli','result':'negative','tested_at':'2026-09-23',
               'latitude':None,'longitude':None}
        first = c.post('/api/tests', json=new).json()
        self.assertFalse(first['duplicate'])
        duplicate = c.post('/api/tests',json=new).json()
        self.assertTrue(duplicate['duplicate'])
        fix = c.patch(f'/api/tests/{first["id"]}/location', json={'latitude':9.99,'longitude':76.3})
        self.assertEqual(fix.status_code, 200)
        bulk = c.post('/api/import/bulk',json={'rainfall':[{'ward_id':'Ward 3','date':'2026-09-23','rainfall_mm':10}],
                                               'ward_geojson':{'type':'FeatureCollection','features':[]}})
        self.assertEqual(bulk.status_code,200)
        self.assertEqual(c.get('/api/ward-boundaries').status_code,200)
        c.post('/api/demo/clear')
        after = c.get('/api/dashboard').json()
        self.assertEqual(after['stats']['total'],1)

if __name__ == '__main__':
    unittest.main()
