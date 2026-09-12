"""Contract tests for the preserved Atlas Twin, not the replaced v3 layout.

Executable marker/heat tests live in scripts/test-atlas-workspace.mjs;
authenticated demand and ownership tests live in test_v3_atlas_merge.py.
The team's scenario renderer continues using map.js and twin-legend.js.
"""
from pathlib import Path
import pytest

FRONTEND = Path(__file__).resolve().parents[3] / 'app' / 'frontend'

def asset(name):
    return (FRONTEND / 'js' / name).read_text()

@pytest.mark.parametrize('module', ['atlas-map.js', 'twin3d.js'])
def test_role_and_utilisation_use_one_shared_style(module):
    js = asset(module)
    assert 'markerStyle' in js and "from './atlas-geography.js'" in js

@pytest.mark.parametrize('icon', ['factory', 'warehouse', 'map-pin'])
def test_role_icons_are_shipped_and_keyed(icon):
    assert (FRONTEND / 'assets' / 'icons' / (icon + '.svg')).is_file()
    assert icon in asset('atlas-geography.js')
    assert icon + '.svg' in (FRONTEND / 'index.html').read_text()

def test_status_is_not_encoded_as_facility_type():
    js = asset('atlas-geography.js')
    assert "if(role==='dc')" in js
    assert 'node.utilPct>=95' in js and 'node.utilPct>=85' in js
    assert 'node.isOpen === false' in js
    assert 'Number.isFinite(node.utilPct)' in js

def test_ids_and_names_survive_into_tooltips():
    js = asset('atlas-map.js')
    assert 'escapeMapText(node.name)' in js and 'escapeMapText(node.id)' in js
    three = asset('twin3d.js')
    assert 'String(data.id' in three and 'String(data.name' in three
    assert 'hud-id' in three

def test_3d_icons_have_a_raycast_target():
    js = asset('twin3d.js')
    assert 'new THREE.Sprite(' in js
    assert 'hit.userData={nodeData:data}' in js
    assert 'icon.src=style.icon' in js

def test_hover_card_can_be_reached_and_opens_details():
    js = asset('twin3d.js')
    assert 'function scheduleHudHide()' in js
    assert 'if (hudHovered) return;' in js
    assert "addEventListener('mouseenter'" in js
    assert 'data-hud-open' in js and 'window.openTwinEntity(id)' in js
    assert 'View market details' in js

def test_blank_entity_cannot_open_a_drawer():
    assert "const footer = !id ? ''" in asset('twin3d.js')

def test_heat_is_bound_to_snapshot_not_to_old_scenario_workspace():
    js = asset('atlas-workspace.js')
    assert '/api/network/demand-surface' in js
    assert 'location-workspace' not in js
    assert 'data.snapshot_id!==snapshot' in js

def test_geographic_background_is_available_offline():
    assert (FRONTEND / 'assets/maps/natural-earth-mercator.webp').is_file()
    assert 'mercatorUV' in asset('atlas-geography.js')

def test_no_old_calculation_module_dependency():
    for name in ('atlas-map.js', 'twin3d.js', 'atlas-workspace.js'):
        assert "from './calculations.js'" not in asset(name)

def test_scenario_still_uses_team_legend():
    assert 'scenarioLegendHtml' in asset('map.js')
    assert "from './map.js'" in asset('scenarios.js')
