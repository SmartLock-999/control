import mqtt from 'mqtt';

let client: mqtt.MqttClient | null = null;

export const connectMqtt = (url: string, options: mqtt.IClientOptions) => {
  if (client) {
    client.end();
  }
  client = mqtt.connect(url, options);

  client.on('connect', () => {
    console.log('Connected to MQTT broker');
  });

  client.on('error', (err) => {
    console.error('MQTT Connection error: ', err);
    client?.end();
  });

  return client;
};

export const publishMqtt = (topic: string, message: string) => {
  if (client && client.connected) {
    client.publish(topic, message);
  } else {
    console.error('MQTT client is not connected');
  }
};

export const disconnectMqtt = () => {
  if (client) {
    client.end();
    client = null;
  }
};
