/*
 * Copyright 2023 Fraunhofer IEE
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Contributors:
 *       Michel Otto - initial implementation
 *
 */
import {
  Broker,
  ConnectorController,
  BrokerController,
  DssimLogger,
  EnvironmentControllerInterface,
  IdentityProvider,
  Instance,
  LogLevel,
  Scenario,
  ScenarioConfiguration,
  ScenarioControllerInterface,
  waitFor,
  Endpoint,
  Connector,
  IdentityProviderController,
} from 'dssim-core';

import https from 'https';
import http from 'http';

export class ScenarioController implements ScenarioControllerInterface {
  private constructor(
    public scenarioConfiguration: ScenarioConfiguration,
    public envController: EnvironmentControllerInterface
  ) {}

  static async initiate(
    configuration: ScenarioConfiguration
  ): Promise<ScenarioController> {
    const envController = await configuration.environmentControllerFactory();
    const controller = new ScenarioController(configuration, envController);
    if (configuration.identityManagement)
      await controller.startIdentityProvider('myAdmin', 'myPassword');
    return controller;
  }

  async runScenario(scenario: Scenario): Promise<void> {
    await scenario.run(this);
  }

  log(
    level: LogLevel,
    text: string,
    sourceComponent: string,
    labels: {[key: string]: string}
  ): void {
    DssimLogger.getInstance().log(level, text, sourceComponent, labels);
  }

  /*async deployIdentityProvider(
    username: string,
    password: string
  ): Promise<
    IdentityProvider<Instance, IdentityProviderController>
  >;*/
  private async startIdentityProvider<
    I extends Instance,
    C extends IdentityProviderController
  >(
    username: string,
    password: string,
    InstanceType?: new (
      deploymentName: string,
      username: string,
      password: string
    ) => I,
    IdentityProviderControllerType?: new () => C
  ): Promise<IdentityProvider<I, C>> {
    if (InstanceType && IdentityProviderControllerType) {
      const Instance = new InstanceType(
        'identity-provider',
        username,
        password
      );
      await this.envController.deployInstance(Instance);
      return {
        instanceController: Instance,
        componentController: new IdentityProviderControllerType(),
      };
    } else {
      if (this.scenarioConfiguration.identityManagement) {
        const Instance =
          new this.scenarioConfiguration.identityManagement.InstanceType(
            'identity-provider',
            username,
            password
          );
        await this.envController.deployInstance(Instance);
        return {
          instanceController: Instance as I,
          componentController:
            new this.scenarioConfiguration.identityManagement.IdentityProviderControllerType() as C,
        };
      } else {
        throw 'Default Identity Management not set in this configuration.';
      }
    }
  }

  async useConnector<I extends Instance, C extends ConnectorController>(
    username: string,
    password: string,
    hostname: string
  ): Promise<Connector<I, C>> {
    const instance =
      await this.scenarioConfiguration.defaultConnectorInstanceFactory(
        hostname
      );

    instance.endPointUrl = `${process.env.INCLUSTER === '1' ? 'http' : 'https'}://${hostname}`;
    instance.hostname = hostname;
    instance.deploymentName = hostname;

    return {
      instanceController: instance as I,
      componentController:
        new this.scenarioConfiguration.ConnectorControllerType(
          hostname,
          username,
          password,
          instance.endpoints
        ) as C,
    };
  }

  async startConnector<I extends Instance, C extends ConnectorController>(
    username: string,
    password: string,
    hostname: string,
    Instance?: I,
    ConnectorControllerType?: new (
      hostname: string,
      username: string,
      password: string,
      endpoints: Endpoint[]
    ) => C
  ): Promise<Connector<I, C>> {
    this.log(
      'info',
      `Starting Connector ${hostname}`,
      ScenarioController.name,
      {}
    );

    const newInstance = Instance
      ? Instance
      : this.scenarioConfiguration.defaultConnectorInstanceFactory(hostname);
    const newConnectorController = ConnectorControllerType
      ? new ConnectorControllerType(
          hostname,
          username,
          password,
          newInstance.endpoints
        )
      : new this.scenarioConfiguration.ConnectorControllerType(
          hostname,
          username,
          password,
          newInstance.endpoints
        );

    await this.envController.deployInstance(newInstance);
    await this.waitUntilAwailable(newInstance);

    await newConnectorController.initialize();

    return {
      instanceController: newInstance as I,
      componentController: newConnectorController as C,
    };
  }

  async startBroker<I extends Instance, C extends BrokerController>(
    instance: I,
    controller: C
  ): Promise<Broker<I, C>> {
    await this.envController.deployInstance(instance);
    await this.waitUntilAwailable(instance);

    return {
      instanceController: instance,
      componentController: controller,
    };
  }

  async wait(ms: number): Promise<void> {
    this.log('info', `waiting for ${ms}`, ScenarioController.name, {});
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async waitUntilAwailable(instance: Instance): Promise<void> {
    if (instance.healthCheckUrl) {
      const client = process.env.INCLUSTER === '1' ? http : https;
      await waitFor(() => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        return new Promise<boolean>((resolve, reject) => {
          //process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
          client
            .get(instance.healthCheckUrl!, resp => {
              this.log(
                'info',
                `Waiting for 200 on ${instance.healthCheckUrl}, got ${resp.statusCode}`,
                ScenarioController.name,
                {}
              );
              if (resp.statusCode === 200) {
                resolve(true);
              } else {
                resolve(false);
              }
            })
            .on('error', err => {
              this.log(
                'warn',
                `Error while waiting for ${instance.healthCheckUrl}: ${err.message}`,
                ScenarioController.name,
                {}
              );
              resolve(false);
            });
        });
      });
    } else {
      return;
    }
  }

  async tearDown(): Promise<void> {
    await this.envController.tearDown();
  }
}
