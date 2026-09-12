"""Relocation math, real solves, provenance and external-data trust boundaries."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from netgravity.scenarios.location import RelocationSpec, apply_relocation, demand_surface, distance, implementation_impact, relocation_inputs
from netgravity.tests.integration.test_warehouse_deep_dive import _network, _solve
from netgravity.tests.integration.test_calculation_workspace import calculation_client
from app.backend.services.location_research import LocationQuery, query_warehouses


def location_network():
    network = _network(periods=[200,220], inventory=True)
    # Synthetic geography only. Coordinates are inputs, never application defaults.
    points = {"PLANT": (33.7,-85), "DC_N":(33.75,-84.4), "DC_S":(32.8,-83.6),
              "DC_NEW":(33,-82.8), "MKT_N":(34,-84), "MKT_S":(32.4,-83.2)}
    for facility in network.facilities:
        facility.latitude, facility.longitude = points[facility.id]
    # Plausible synthetic lane distances derived transparently for the fixture.
    fac = {f.id:f for f in network.facilities}
    for lane in network.lanes:
        origin, dest = fac[lane.origin_id],fac[lane.destination_id]
        lane.distance_km = distance((origin.latitude,origin.longitude),(dest.latitude,dest.longitude))*1.2
    network.currency="USD"
    return network


def spec(**kwargs):
    return RelocationSpec(**{"latitude":33.9,"longitude":-84.1,"tariff_model":"distance_proportional","acknowledge_estimates":True,**kwargs})


def test_relocation_preserves_snapshot_and_reconciles_every_lane():
    network=location_network(); original=network.model_dump(mode="json")
    moved,_=apply_relocation(network,"DC_N",spec())
    assert network.model_dump(mode="json")==original
    trace=moved.scenario_calculation_context["relocation"]
    assert len(trace["lanes"])==3
    for row in trace["lanes"]:
        ratio=row["new_great_circle_km"]/row["old_great_circle_km"]
        lane=moved.lanes[row["lane_index"]]
        assert lane.distance_km==pytest.approx(row["before"]["distance_km"]*ratio)
        assert lane.rate_per_unit==pytest.approx(row["before"]["rate_per_unit"]*ratio)
        assert lane.lead_time_days==pytest.approx(row["before"]["lead_time_days"]*ratio)
        assert lane.network_distance_km is None
    assert moved.facilities[1].capacity_units_per_period == network.facilities[1].capacity_units_per_period
    baseline,_=_solve(network); result,state=_solve(moved)
    assert result.solver.objective_value != baseline.solver.objective_value
    assert state.calculation_trace["scenario_input_transformations"]["relocation"] == trace


def test_exact_return_to_original_coordinates_has_no_spurious_cost_change():
    network=location_network()
    moved,_=apply_relocation(network,"DC_N",spec(latitude=33.75,longitude=-84.4))
    assert [l.model_dump() for l in moved.lanes][0]["distance_km"] == network.lanes[0].distance_km
    before,_=_solve(network); after,_=_solve(moved)
    assert before.objective_components==pytest.approx(after.objective_components)


def test_component_tariffs_preserve_fixed_charges_and_terminal_time():
    network=location_network()
    for lane in network.lanes:
        lane.rate_per_km=.03;lane.fixed_leg_cost=2;lane.speed_km_per_day=300;lane.terminal_time_days=.25
    trace=relocation_inputs(network,"DC_N",spec(tariff_model="uploaded_components"))
    for row in trace["lanes"]:
        assert row["after"]["rate_per_unit"]==pytest.approx(2+.03*row["after"]["distance_km"])
        assert row["after"]["lead_time_days"]==pytest.approx(.25+row["after"]["distance_km"]/300)


def test_replacing_annual_fixed_cost_uses_the_actual_horizon():
    network=location_network()
    moved,_=apply_relocation(network,"DC_N",spec(latitude=33.75,longitude=-84.4,annual_fixed_cost=3600,cost_source="QA estimate"))
    _,before=_solve(network);_,after=_solve(moved)
    assert after.costs.facility_cost-before.costs.facility_cost==pytest.approx((3600-2400)/12*2)


def test_geographically_inconsistent_distances_and_missing_components_fail():
    network=location_network();network.lanes[0].distance_km=1
    with pytest.raises(ValueError,match="shorter than"):
        relocation_inputs(network,"DC_N",spec())
    with pytest.raises(ValueError,match="missing a rate"):
        relocation_inputs(location_network(),"DC_N",spec(tariff_model="uploaded_components"))


@pytest.mark.parametrize("change", [dict(latitude=float('nan')),dict(longitude=181),dict(fit_out=-1),dict(acknowledge_estimates=False),dict(moving=0),dict(candidate_id="way/1")])
def test_invalid_or_unsourced_inputs_are_rejected(change):
    with pytest.raises(ValueError):spec(**change)


def test_unusable_lane_and_nonoperating_site_are_not_silently_ignored():
    network=location_network()
    for fid in ("MKT_N","DC_NEW","UNKNOWN"):
        with pytest.raises(ValueError):relocation_inputs(network,fid,spec())
    network.lanes[0].distance_km=0
    with pytest.raises(ValueError,match="baseline distance"):relocation_inputs(network,"DC_N",spec())
    network=location_network();network.facilities[0].latitude=None
    with pytest.raises(ValueError,match="geographic coordinates"):relocation_inputs(network,"DC_N",spec())
    network=location_network();network.lanes[0].tariff_requires_user_input=True
    with pytest.raises(ValueError,match="quote"):relocation_inputs(network,"DC_N",spec())


def test_heatmap_counts_demand_and_discloses_missing_coordinates():
    network=location_network();network.facilities[-1].latitude=None
    surface=demand_surface(network)
    assert surface["total_quantity"]==630
    assert surface["mapped_quantity"]==420
    assert surface["coverage_pct"]==pytest.approx(100*2/3)
    assert surface["omitted"][0]["id"]=="MKT_S"
    assert surface["centre"]["latitude"]==pytest.approx(34)


def test_spherical_centre_handles_date_line_and_zero_demand():
    network=location_network()
    for f in network.facilities:
        if f.id=="MKT_N":f.latitude,f.longitude=0,179
        if f.id=="MKT_S":f.latitude,f.longitude=0,-179
    centre=demand_surface(network)["centre"]
    assert abs(centre["longitude"])>178
    for row in network.demands:row.quantity=0
    assert demand_surface(network)["centre"] is None


def test_unknown_implementation_cost_is_not_zero_and_once_only():
    network=location_network()
    trace=relocation_inputs(network,"DC_N",spec())
    assert implementation_impact(trace,100,90)["net_horizon_impact"] is None
    trace=relocation_inputs(network,"DC_N",spec(fit_out=20,moving=10,lease_exit=0,other=5,cost_source="Synthetic test budget"))
    impact=implementation_impact(trace,100,90)
    assert impact["one_time_cost"]==35
    assert impact["net_horizon_impact"]==25
    assert impact["scenario_plus_implementation"]==125


def provider_response(raw):
    response=Mock(status_code=200)
    response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
    response.iter_content=Mock(return_value=[json.dumps(raw).encode()])
    return response


def test_external_lookup_is_sourced_bounded_and_never_invents_rent():
    post=Mock(return_value=provider_response({"elements":[{"type":"way","id":12,"center":{"lat":33.9,"lon":-84.1},"tags":{"name":"Mapped site","building":"warehouse","website":"javascript:bad"}}]}))
    result=query_warehouses(LocationQuery(latitude=33.9,longitude=-84.1,radius_km=5,consent_external=True),post=post)
    assert result["results"][0]["source_url"]=="https://www.openstreetmap.org/way/12"
    assert result["results"][0]["rent"] is None
    assert "website" not in result["results"][0]["tags"]
    assert post.call_args.kwargs["allow_redirects"] is False
    assert "out tags center 101" in post.call_args.kwargs["data"]["data"]
    with pytest.raises(ValueError):LocationQuery(latitude=0,longitude=0,radius_km=26,consent_external=True)
    with pytest.raises(ValueError):LocationQuery(latitude=0,longitude=0,radius_km=5,consent_external=False)


def test_partial_external_response_is_a_failure_not_no_results():
    from app.backend.services.errors import ValidationError
    post=Mock(return_value=provider_response({"remark":"runtime timeout","elements":[]}))
    with pytest.raises(ValidationError,match="unavailable"):
        query_warehouses(LocationQuery(latitude=33.9,longitude=-84.1,radius_km=5,consent_external=True),post=post)


def test_api_move_is_real_traceable_and_snapshot_scoped(calculation_client):
    client,orch=calculation_client
    snap=orch.snapshots.register(location_network())
    headers={"Authorization":"Bearer owner"}
    scope={"project_id":"owned","snapshot_id":snap.snapshot_id}
    workspace=client.get('/api/scenarios/location-workspace',query_string=scope,headers=headers).get_json()
    assert workspace["demand"]["total_quantity"]==630
    assert client.get('/api/scenarios/location-workspace',query_string=scope).status_code==401
    payload={**scope,"facility_id":"DC_N","relocation":spec(fit_out=20,moving=10,lease_exit=0,other=5,cost_source="Synthetic QA budget").model_dump()}
    preview=client.post('/api/scenarios/location-preview',json=payload,headers=headers)
    assert preview.status_code==200,preview.get_json()
    result=client.post('/api/scenarios/simulate',json={**payload,"facility_ids":["DC_N"],"name":"Move QA","action":"MOVE_FACILITY"},headers=headers)
    assert result.status_code==201,result.get_json()
    record=result.get_json()
    assert record["moved_sites"][0]["lat"]==33.9
    assert record["implementation_impact"]["one_time_cost"]==35
    assert "lanes" not in record["relocation"],"Heavy audit stays out of the ordinary scenario list"
    report=client.get(f"/api/scenarios/{record['id']}/calculations",query_string=scope,headers=headers).get_json()
    assert report["sources"]["relocation"]["lanes"]==preview.get_json()["relocation"]["lanes"]
    assert report["metrics"][0]["value"]==35
    assert len([row for row in report["metrics"] if row["id"].startswith("location:lane:")])==9
    from io import BytesIO
    from zipfile import ZipFile
    from xml.etree import ElementTree
    word=client.get(f"/api/scenarios/{record['id']}/calculations",query_string={**scope,"format":"docx"},headers=headers)
    assert word.status_code==200
    with ZipFile(BytesIO(word.data)) as archive:
        document="".join(ElementTree.fromstring(archive.read("word/document.xml")).itertext())
    document=document.replace("\u200b", "")
    assert "Lane distance PLANT" in document
    assert "Synthetic QA budget" in document
    assert "Onetime implementation cost" in document
    assert orch.snapshots.get(snap.snapshot_id).network.facilities[1].latitude==33.75
    stale=client.post('/api/scenarios/location-preview',json={**payload,"snapshot_id":"old"},headers=headers)
    assert stale.status_code==409
    assert client.post('/api/scenarios/location-preview',json={**payload,"project_id":"other"},headers=headers).status_code==404


def test_research_is_cached_and_saved_with_the_selected_scenario(calculation_client,monkeypatch):
    from app.backend.services import location_research
    client,orch=calculation_client
    snap=orch.snapshots.register(location_network())
    headers={"Authorization":"Bearer owner"}
    scope={"project_id":"owned","snapshot_id":snap.snapshot_id}
    fetch=Mock(return_value={"provider":"test-provider", "retrieved_at":"2026-09-09T00:00:00Z", "results":[
        {"id":"way/12","name":"Test mapped building","latitude":33.9,"longitude":-84.1,"source_url":"https://www.openstreetmap.org/way/12","rent":None}]})
    monkeypatch.setattr(location_research,"query_warehouses",fetch)
    query={**scope,"search":{"latitude":33.9,"longitude":-84.1,"radius_km":5,"consent_external":True}}
    research=client.post('/api/scenarios/location-research',json=query,headers=headers).get_json()
    again=client.post('/api/scenarios/location-research',json=query,headers=headers).get_json()
    assert again==research and fetch.call_count==1
    payload={**scope,"facility_ids":["DC_N"],"name":"Research-backed move QA","action":"MOVE_FACILITY",
             "relocation":spec(research_id=research["research_id"],candidate_id="way/12").model_dump()}
    forged={**payload,"relocation":{**payload["relocation"],"latitude":35}}
    assert client.post('/api/scenarios/simulate',json=forged,headers=headers).status_code==400
    result=client.post('/api/scenarios/simulate',json=payload,headers=headers)
    assert result.status_code==201,result.get_json()
    record=result.get_json()
    report=client.get(f"/api/scenarios/{record['id']}/calculations",query_string=scope,headers=headers).get_json()
    stored=report["sources"]["scenario"]["location_research"]
    assert stored["results"][0]["source_url"]=="https://www.openstreetmap.org/way/12"
    assert stored["research_id"]==research["research_id"]
    assert record["implementation_impact"]["net_horizon_impact"] is None
