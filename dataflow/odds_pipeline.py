import apache_beam as beam
from apache_beam.options.pipeline_options import PipelineOptions, StandardOptions
from apache_beam.io.gcp.spanner import SpannerInsertOrUpdate
from typing import NamedTuple, Optional
import json
import requests
import logging

import datetime

class LiveOddsRow(NamedTuple):
    MarketId: str
    Timestamp: str
    HomeFair: float
    AwayFair: float
    DrawFair: Optional[float]
    Overround: float
    RawHomeOdds: int
    RawAwayOdds: int
    DevigMethod: str

beam.coders.registry.register_coder(LiveOddsRow, beam.coders.RowCoder)

class DevigOddsFn(beam.DoFn):
    def __init__(self, api_url):
        self.api_url = api_url

    def process(self, element):
        try:
            payload = json.loads(element)
            # Make stateless HTTP call to Cloud Run math API
            response = requests.post(self.api_url, json={
                "prices": payload.get("prices"),
                "market": payload.get("market")
            }, timeout=5.0)
            response.raise_for_status()
            
            result = response.json()
            yield beam.pvalue.TaggedOutput('success', {
                "original": payload,
                "devigged": result
            })
        except Exception as e:
            logging.error(f"Failed to devig odds: {e}")
            yield beam.pvalue.TaggedOutput('dlq', element)

def run(argv=None):
    options = PipelineOptions(argv)
    options.view_as(StandardOptions).streaming = True

    p = beam.Pipeline(options=options)

    # Note: These values should be provided via pipeline arguments in production
    input_topic = "projects/gen-lang-client-0281999829/topics/live-odds-ingest"
    dlq_topic = "projects/gen-lang-client-0281999829/topics/live-odds-dlq"
    spanner_instance = "clearspace"
    spanner_database = "sports-mlb-db"
    math_api_url = "https://reverie-70323048967.us-central1.run.app/api/math/devig"

    raw_odds = (p 
                | "ReadFromPubSub" >> beam.io.ReadFromPubSub(topic=input_topic))

    devig_results = (raw_odds 
                     | "DevigOdds" >> beam.ParDo(DevigOddsFn(math_api_url)).with_outputs('success', 'dlq'))

    # Sink successfully processed odds to Spanner
    # Using a hypothetical write transform, often custom or via Beam GCP IOs
    (devig_results.success
     | "FormatForSpanner" >> beam.Map(lambda x: LiveOddsRow(
         MarketId=x['original']['market_id'], 
         Timestamp=datetime.datetime.utcnow().isoformat() + 'Z',
         HomeFair=float(x['devigged']['deviggedProbabilities'][0]),
         AwayFair=float(x['devigged']['deviggedProbabilities'][1]),
         DrawFair=float(x['devigged']['deviggedProbabilities'][2]) if len(x['devigged']['deviggedProbabilities']) > 2 else None,
         Overround=float(x['devigged'].get('overround') or 0.0),
         RawHomeOdds=int(x['original']['prices'][0]),
         RawAwayOdds=int(x['original']['prices'][1]),
         DevigMethod=str(x['devigged'].get('method', 'unknown'))
     )).with_output_types(LiveOddsRow)
     | "WriteToSpanner" >> SpannerInsertOrUpdate(
         project_id="gen-lang-client-0281999829",
         instance_id=spanner_instance,
         database_id=spanner_database,
         table="LiveOdds"
     ))

    # Sink failures to DLQ
    (devig_results.dlq
     | "WriteToDLQ" >> beam.io.WriteToPubSub(topic=dlq_topic))

    result = p.run()
    result.wait_until_finish()

if __name__ == '__main__':
    logging.getLogger().setLevel(logging.INFO)
    run()
